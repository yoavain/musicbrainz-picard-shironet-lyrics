// Deploy, rollback and pull-prod for the server in the LXC container (CT 194), run from
// the Windows dev box:
//
//   npm run deploy [-- --allow-destructive] [--no-restart]
//                                            the committed server/ -> a new release
//   npm run rollback                         the release before the current one
//   npm run pull-prod -- <file> [--force]     a copy of the production database -> <file>
//
// Environment: LYRICS_SERVER_SSH_KEY (default ~/.ssh/id_ed25519_calpuzzle) and
// LYRICS_SERVER_DEPLOY_TARGET (default deploy@192.168.68.194). The box layout, the users
// and the sudo rule belong to the network repo. Data only flows production -> dev here;
// the one-time copy into the container is the cutover, done by hand.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkDatabase } from '../src/dbtools.ts';
import { MIGRATIONS } from '../src/migrations.ts';
import {
  REMOTE, destructiveSteps, healthPollScript, isReleaseId, previousRelease, releaseId, releasesToDelete, sshArgs,
  switchCommand, systemctl,
} from './deploy-lib.ts';

const SERVER_DIR = resolve(import.meta.dirname, '..');
const REPO_DIR = resolve(SERVER_DIR, '..');
const KEY = process.env.LYRICS_SERVER_SSH_KEY || join(homedir(), '.ssh', 'id_ed25519_calpuzzle');
const TARGET = process.env.LYRICS_SERVER_DEPLOY_TARGET || 'deploy@192.168.68.194';
/** What a release holds: the app, without tests and tools. */
const RELEASE_PATHS = ['src', 'package.json', 'package-lock.json'];

class Failure extends Error {}

function run(command: string, args: string[], options: { input?: number; output?: number } = {}): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: [options.input ?? 'ignore', options.output ?? 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Failure(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    const hint = /Host key verification failed/.test(stderr)
      ? `\nThe container's host key is not in known_hosts. Run "ssh -i ${KEY} ${TARGET} true" once and compare the key with the fingerprint the network repo recorded.`
      : '';
    throw new Failure(`${command} ${args.at(-1)} failed (exit ${result.status}): ${stderr}${hint}`);
  }
  return result.stdout ?? '';
}

function ssh(command: string, options: { input?: number; output?: number } = {}): string {
  return run('ssh', sshArgs(KEY, TARGET, command), options);
}

function git(...args: string[]): string {
  return run('git', ['-C', REPO_DIR, ...args]).trim();
}

interface RemoteState {
  releases: string[];
  current: string | null;
  health: { commit: string | null; schemaVersion: number | null } | null;
}

function remoteState(): RemoteState {
  const listing = ssh(`ls -1 ${REMOTE.releases}; echo "--"; readlink ${REMOTE.current} || true`);
  const [names, link = ''] = listing.split('--\n');
  const releases = names.split('\n').map((name) => name.trim()).filter(isReleaseId);
  const current = link.trim().split('/').at(-1) || null;
  const health = JSON.parse(ssh(healthPollScript(0)).trim() || 'null');
  return { releases, current: current && isReleaseId(current) ? current : null, health };
}

/** Restarts the unit and waits for /health to answer with the commit; null on time-out. */
function restartAndWait(commit: string | null): { commit: string | null; schemaVersion: number | null } | null {
  ssh(systemctl('restart'));
  return JSON.parse(ssh(healthPollScript(90, commit)).trim() || 'null');
}

function showJournal(): void {
  try {
    console.error(ssh(`journalctl -u ${REMOTE.unit} -n 30 --no-pager`));
  } catch (error) {
    console.error(`(no journal: ${(error as Error).message})`);
  }
}

async function deploy(args: string[]): Promise<number> {
  const allowDestructive = args.includes('--allow-destructive');
  // The first deploy, before the cutover: install and switch, but do not start the
  // service (it would create an empty database).
  const noRestart = args.includes('--no-restart');
  const dirty = git('status', '--porcelain', '--', 'server');
  if (dirty) throw new Failure(`server/ has uncommitted or untracked files; commit them first:\n${dirty}`);
  const commit = git('rev-parse', 'HEAD');
  const id = releaseId(new Date(), commit);

  const state = remoteState();
  console.log(`Target ${TARGET}: current ${state.current ?? 'none'}, running ${state.health ? `${state.health.commit ?? '?'} (schema ${state.health.schemaVersion})` : 'no'}.`);
  if (state.health?.commit === commit) {
    console.log(`Commit ${commit.slice(0, 7)} is already running; nothing to do.`);
    return 0;
  }
  const destructive = destructiveSteps(state.health?.schemaVersion ?? null, MIGRATIONS);
  if (destructive.length > 0) {
    const list = destructive.map((step) => `  v${step.to}: ${step.description}`).join('\n');
    if (!allowDestructive) {
      throw new Failure(`Destructive migrations may run${state.health ? '' : ' (the running schema is unknown)'}:\n${list}\nThe server copies the database to backups/ first. Run again with --allow-destructive.`);
    }
    console.log(`Destructive migrations allowed:\n${list}`);
  }

  const work = mkdtempSync(join(tmpdir(), 'lyrics-deploy-'));
  try {
    const archive = join(work, 'release.tar.gz');
    const release = JSON.stringify({ commit, time: new Date().toISOString() });
    git('archive', '--format=tar.gz', `--add-virtual-file=release.json:${release}`, '-o', archive, 'HEAD:server', ...RELEASE_PATHS);
    const dir = `${REMOTE.releases}/${id}`;
    console.log(`Uploading ${id}...`);
    const input = openSync(archive, 'r');
    try {
      ssh(`set -e; umask 0027; mkdir ${dir}; tar -xzf - -C ${dir}`, { input });
    } finally {
      closeSync(input);
    }
    console.log('Installing dependencies (npm ci)...');
    try {
      ssh(`set -e; cd ${dir}; PATH=${REMOTE.nodeBin}:$PATH npm ci --omit=dev --no-audit --no-fund --loglevel=error`);
    } catch (error) {
      ssh(`rm -rf ${dir}`);
      throw error;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  ssh(switchCommand(id));
  if (noRestart) {
    console.log(`Switched to ${id}. Not restarted (--no-restart): the old code runs until the next restart.`);
    return 0;
  }
  console.log(`Switched to ${id}; restarting ${REMOTE.unit}...`);
  const health = restartAndWait(commit);
  if (health?.commit !== commit) {
    console.error(`The new release did not come up (health: ${JSON.stringify(health)}).`);
    showJournal();
    if (state.current) {
      ssh(switchCommand(state.current));
      const back = restartAndWait(null);
      console.error(`Rolled back to ${state.current} (health: ${JSON.stringify(back)}).`);
    } else {
      console.error('No earlier release to roll back to.');
    }
    return 1;
  }
  console.log(`Running ${commit.slice(0, 7)}, schema ${health.schemaVersion}.`);
  const old = releasesToDelete([...state.releases, id], id);
  if (old.length > 0) {
    ssh(`rm -rf ${old.map((name) => `${REMOTE.releases}/${name}`).join(' ')}`);
    console.log(`Removed old releases: ${old.join(', ')}`);
  }
  return 0;
}

async function rollback(): Promise<number> {
  const state = remoteState();
  const target = previousRelease(state.releases, state.current);
  if (!target) throw new Failure(`No release before ${state.current ?? 'none'}.`);
  const commit = JSON.parse(ssh(`cat ${REMOTE.releases}/${target}/release.json`)).commit as string;
  ssh(switchCommand(target));
  console.log(`Switched to ${target}; restarting ${REMOTE.unit}...`);
  const health = restartAndWait(commit);
  if (health?.commit !== commit) {
    console.error(`${target} did not come up (health: ${JSON.stringify(health)}).`);
    showJournal();
    console.error('If the log says the database schema is newer, the database was migrated after this release.'
      + ` Its pre-migration copy is in ${REMOTE.data}/backups/.`);
    return 1;
  }
  console.log(`Running ${commit.slice(0, 7)} again.`);
  return 0;
}

async function pullProd(args: string[]): Promise<number> {
  const force = args.includes('--force');
  const [target] = args.filter((arg) => arg !== '--force');
  if (!target) {
    console.error('Usage: npm run pull-prod -- <local file> [--force]');
    return 2;
  }
  const path = resolve(target);
  if (existsSync(path) && !force) throw new Failure(`${path} exists; pass --force to replace it.`);
  const partial = `${path}.partial`;
  const remoteCopy = `/tmp/lyrics-pull-${process.pid}.sqlite3`;
  // backup reads the database read-only (no lock), so the service keeps running. deploy
  // can only read the -shm file; SQLite's read-only path may answer BUSY now and then.
  for (let attempt = 1; ; attempt += 1) {
    const output = openSync(partial, 'w');
    try {
      ssh(`set -e; trap 'rm -f ${remoteCopy}' EXIT; cd ${REMOTE.current}; `
        + `${REMOTE.node} src/cli.ts backup ${remoteCopy} --db ${REMOTE.data}/lyrics.sqlite3 >&2; cat ${remoteCopy}`, { output });
      closeSync(output);
      break;
    } catch (error) {
      closeSync(output);
      rmSync(partial, { force: true });
      if (attempt >= 3 || !/SQLITE_BUSY|database is locked/i.test((error as Error).message)) throw error;
      console.log(`The database was busy; trying again (${attempt + 1} of 3)...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  const report = checkDatabase(partial);
  if (!report.ok) {
    rmSync(partial, { force: true });
    throw new Failure(`The copy failed the integrity check: ${report.integrity.join('; ')}`);
  }
  rmSync(path, { force: true });
  renameSync(partial, path);
  console.log(`Copied production to ${path}: ${report.counts.lyrics} lyrics, schema ${report.schemaVersion}.`);
  return 0;
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = { deploy, rollback, 'pull-prod': pullProd };

const [name, ...rest] = process.argv.slice(2);
const command = name ? COMMANDS[name] : undefined;
if (!command) {
  console.error(`Usage: node tools/deploy.ts <${Object.keys(COMMANDS).join(' | ')}> [arguments]`);
  process.exit(2);
}
try {
  process.exit(await command(rest));
} catch (error) {
  console.error(error instanceof Failure ? error.message : error);
  process.exit(1);
}
