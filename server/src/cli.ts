// Command-line entry point: node src/cli.ts <command> [arguments]

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { buildApp } from './api.ts';
import { DB_FILE, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { importPythonCache } from './importer.ts';
import { acquireLock, isLocked } from './lock.ts';
import { LyricsService } from './service.ts';
import { Store } from './store.ts';

/** A command returns an exit code, or null to keep the process running. */
type Command = (args: string[]) => Promise<number | null>;

async function serve(): Promise<number | null> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const release = acquireLock(config.dataDir);
  let store: Store;
  try {
    store = new Store(join(config.dataDir, DB_FILE));
  } catch (error) {
    release();
    throw error;
  }
  const app = buildApp({
    service: new LyricsService(store), allowedHosts: config.allowedHosts, version: pkg.version, logger: true,
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'stopping');
    await app.close();
    store.close();
    release();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => { void stop(signal); });
  }

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    store.close();
    release();
    throw error;
  }
  app.log.info({ dataDir: config.dataDir, version: pkg.version }, 'serving');
  return null;
}

/** True when a server answers on the configured address. */
async function serverAnswers(config: Config): Promise<boolean> {
  try {
    const reply = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1000) });
    return reply.ok;
  } catch {
    return false;
  }
}

async function importCommand(args: string[]): Promise<number> {
  const [oldPath] = args;
  if (!oldPath) {
    console.error('Usage: node src/cli.ts import <path to the old lyrics.sqlite3>');
    return 2;
  }
  const config = loadConfig();
  if (isLocked(config.dataDir) || await serverAnswers(config)) {
    console.error('Stop the server first: import needs it stopped.');
    return 1;
  }
  mkdirSync(config.dataDir, { recursive: true });
  const release = acquireLock(config.dataDir);
  const store = new Store(join(config.dataDir, DB_FILE));
  try {
    const report = importPythonCache(oldPath, store);
    console.log(`Imported into ${config.dataDir}:`);
    console.log(`  lyrics: ${report.lyrics}, queue: ${report.queue}, requests: ${report.requests}`);
    console.log(`  keys changed by the new rules: ${report.keyChanges.length}`);
    for (const change of report.keyChanges) {
      console.log(`    [${change.table}] ${change.artist} - ${change.title}: "${change.oldKey}" -> "${change.newKey}"`);
    }
    console.log(`  rows not imported: ${report.problems.length}`);
    for (const problem of report.problems) {
      console.log(`    [${problem.table}] ${problem.artist} - ${problem.title}: ${problem.problem}`);
    }
    return 0;
  } finally {
    store.close();
    release();
  }
}

const COMMANDS: Record<string, Command> = { serve, import: importCommand };

async function main(): Promise<void> {
  const [name, ...args] = process.argv.slice(2);
  const command = name ? COMMANDS[name] : undefined;
  if (!command) {
    console.error(`Usage: node src/cli.ts <${Object.keys(COMMANDS).join(' | ')}> [arguments]`);
    process.exit(2);
  }
  try {
    const code = await command(args);
    if (code !== null) process.exit(code);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

await main();
