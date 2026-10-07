// Pure parts of the deploy script (tools/deploy.ts): names, choices and the remote shell
// commands. The box layout is the network repo's (CT 194); see docs in the README.

import type { Migration } from '../src/migrations.ts';

export const REMOTE = {
  app: '/opt/shironet-lyrics',
  releases: '/opt/shironet-lyrics/releases',
  current: '/opt/shironet-lyrics/current',
  data: '/var/lib/shironet-lyrics',
  /** A non-login ssh command does not source /etc/profile.d: absolute paths. */
  node: '/opt/node/bin/node',
  nodeBin: '/opt/node/bin',
  unit: 'shironet-lyrics',
  port: 8735,
} as const;

export const KEEP_RELEASES = 3;
const RELEASE_ID = /^\d{8}T\d{6}Z-[0-9a-f]{7,40}$/;

export function releaseId(now: Date, commit: string): string {
  return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z-${commit.slice(0, 7)}`;
}

export function isReleaseId(name: string): boolean {
  return RELEASE_ID.test(name);
}

/** Releases to delete: all but the newest `keep`, and never the current one. */
export function releasesToDelete(names: readonly string[], current: string | null, keep: number = KEEP_RELEASES): string[] {
  return [...names].sort().reverse().slice(keep).filter((name) => name !== current).sort();
}

/** The newest release older than the current one (the rollback target). */
export function previousRelease(names: readonly string[], current: string | null): string | null {
  if (current === null) return null;
  return [...names].sort().reverse().find((name) => name < current) ?? null;
}

/** Destructive steps the deploy would run; an unknown remote version counts every step. */
export function destructiveSteps(remoteVersion: number | null, migrations: readonly Migration[]): Migration[] {
  return migrations.filter((step) => step.destructive && (remoteVersion === null || step.to > remoteVersion));
}

/** The sudo rule matches arguments exactly: nothing may follow the unit name. */
export function systemctl(action: 'start' | 'stop' | 'restart' | 'status' | 'is-active'): string {
  return `sudo -n systemctl ${action} ${REMOTE.unit}`;
}

/** systemctl is-active prints one word; only "active" means the service holds the database. */
export function isActive(output: string): boolean {
  return output.trim() === 'active';
}

/** Points `current` at a release: a new link, renamed over the old one (atomic). */
export function switchCommand(id: string): string {
  if (!isReleaseId(id)) throw new Error(`Not a release id: ${id}`);
  return `ln -sfn ${REMOTE.releases}/${id} ${REMOTE.app}/current.new && mv -Tf ${REMOTE.app}/current.new ${REMOTE.current}`;
}

export function sshArgs(key: string, target: string, command: string): string[] {
  return ['-i', key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=10', target, command];
}

/**
 * A remote command that polls /health on the box for up to `seconds` and prints the last
 * answer (or null). With `commit`, it waits for that commit. /health needs no token.
 */
export function healthPollScript(seconds: number, commit: string | null = null): string {
  const want = commit === null ? 'null' : JSON.stringify(commit);
  const js = `const end=Date.now()+${seconds}*1000,want=${want};let last=null;`
    + `(async()=>{for(;;){try{const r=await fetch("http://127.0.0.1:${REMOTE.port}/health");`
    + `if(r.ok){last=await r.json();if(want===null||last.commit===want)break}}catch{}`
    + `if(Date.now()>end)break;await new Promise((f)=>setTimeout(f,2000))}console.log(JSON.stringify(last))})()`;
  return `${REMOTE.node} -e '${js}'`;
}
