// Command-line entry point: node src/cli.ts <command> [arguments]

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { buildApp } from './api.ts';
import { calibrationReport, enqueueCalibration } from './calibration.ts';
import { recoverLeftovers } from './chrome.ts';
import { DB_FILE, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { importPythonCache } from './importer.ts';
import { acquireLock, isLocked } from './lock.ts';
import { createLogStream } from './logstream.ts';
import { createNotifier } from './notifier.ts';
import type { Logger } from './notifier.ts';
import { DEFAULT_LIMITS, Pacer, loadPace } from './pacer.ts';
import * as queue from './queue.ts';
import { ChromeReader, openChromeSession } from './reader.ts';
import { LyricsService } from './service.ts';
import { searchUrl, BASE_URL } from './shironet.ts';
import { Store, isoTime } from './store.ts';
import { Worker } from './worker.ts';
import { isAlive } from './processes.ts';

/** A command returns an exit code, or null to keep the process running. */
type Command = (args: string[]) => Promise<number | null>;

const consoleLogger: Logger = {
  debug: () => {},
  info: (obj, msg) => console.log(msg ?? '', Object.keys(obj).length ? JSON.stringify(obj) : ''),
  warn: (obj, msg) => console.warn(msg ?? '', Object.keys(obj).length ? JSON.stringify(obj) : ''),
  error: (obj, msg) => console.error(msg ?? '', Object.keys(obj).length ? JSON.stringify(obj) : ''),
};

function readerLimits(config: Config) {
  return {
    idleMs: config.browser.idleMinutes * 60_000,
    maxAgeMs: config.browser.maxAgeMinutes * 60_000,
    maxPages: config.browser.maxPages,
    maxMemoryBytes: config.browser.maxMemoryMb * 1024 * 1024,
    humanPollMs: 15_000,
    memoryCheckMs: 60_000,
  };
}

async function serve(): Promise<number | null> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const release = acquireLock(config.dataDir);
  const logStream = createLogStream(join(config.dataDir, 'server.log'));
  let store: Store;
  try {
    store = new Store(join(config.dataDir, DB_FILE));
  } catch (error) {
    logStream.close();
    release();
    throw error;
  }

  // The service needs the worker's hooks and the worker needs the app's logger:
  // the hooks reach the worker through this variable once it exists.
  let worker: Worker | null = null;
  const service = new LyricsService(store, undefined, {
    inFlight: () => worker?.inFlight() ?? null,
    onQueued: () => worker?.wake(),
    extraStatus: () => (worker ? (worker.status() as unknown as Record<string, unknown>) : { running: false }),
  });
  const app = buildApp({
    service, allowedHosts: config.allowedHosts, version: pkg.version,
    logger: { level: config.logLevel, stream: logStream }, calibrationGapDays: config.worker.calibrationGapDays,
  });
  const log = app.log as unknown as Logger;

  await recoverLeftovers(config.dataDir, log);
  const limits = { ...DEFAULT_LIMITS, ...config.pace };
  const reader = new ChromeReader(
    () => openChromeSession({ chromePath: config.chromePath, dataDir: config.dataDir }, log), readerLimits(config), log,
  );
  worker = new Worker({
    store, reader, log, options: config.worker,
    pacer: new Pacer(loadPace(store, limits), limits),
    notifier: createNotifier({ windows: config.notify.windows, ntfyUrl: config.notify.ntfyUrl, log }),
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'stopping');
    setTimeout(() => { process.exit(1); }, 20_000).unref(); // hard limit
    try {
      await worker?.stop(); // closes the browser: processes and profile
      await app.close();
    } finally {
      store.close();
      logStream.close();
      release();
      process.exit(0);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => { void stop(signal); });
  }

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    store.close();
    logStream.close();
    release();
    throw error;
  }
  log.info({ dataDir: config.dataDir, version: pkg.version, chrome: config.chromePath, url: `http://${config.host}:${config.port}`, log: join(config.dataDir, 'server.log') }, 'serving');
  worker.start();
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

async function postAdmin(config: Config, path: string, body: unknown): Promise<unknown> {
  const reply = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
  });
  if (!reply.ok) throw new Error(`${path} answered ${reply.status}: ${await reply.text()}`);
  return reply.json();
}

/** Runs fn on the database directly, with the lock (the server is not running). */
async function withStore<T>(config: Config, fn: (store: Store) => T): Promise<T> {
  mkdirSync(config.dataDir, { recursive: true });
  const release = acquireLock(config.dataDir);
  const store = new Store(join(config.dataDir, DB_FILE));
  try {
    return fn(store);
  } finally {
    store.close();
    release();
  }
}

async function statusCommand(): Promise<number> {
  const config = loadConfig();
  if (await serverAnswers(config)) {
    const reply = await fetch(`http://127.0.0.1:${config.port}/status`);
    console.log(JSON.stringify(await reply.json(), null, 2));
    return 0;
  }
  if (isLocked(config.dataDir)) {
    console.error('The data dir is locked (an import is running?).');
    return 1;
  }
  const status = await withStore(config, (store) => ({
    server: 'not running',
    ...new LyricsService(store).status(),
    recentRequests: queue.recentRequests(store, 20),
    calibration: calibrationReport(store),
  }));
  console.log(JSON.stringify(status, null, 2));
  return 0;
}

async function requeueCommand(): Promise<number> {
  const config = loadConfig();
  const count = await serverAnswers(config)
    ? ((await postAdmin(config, '/admin/requeue-not-found', {})) as { count: number }).count
    : await withStore(config, (store) => queue.requeueNotFound(store, isoTime(new Date())));
  console.log(`${count} songs set back to pending.`);
  return 0;
}

async function calibrateCommand(args: string[]): Promise<number> {
  const count = Number(args[0]);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    console.error('Usage: node src/cli.ts enqueue-calibration <1-100>');
    return 2;
  }
  const config = loadConfig();
  const queued = await serverAnswers(config)
    ? ((await postAdmin(config, '/admin/calibrate', { count })) as { queued: number }).queued
    : await withStore(config, (store) => enqueueCalibration(store, count, isoTime(new Date()), config.worker.calibrationGapDays));
  console.log(`${queued} calibration samples queued.`);
  return 0;
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
  const report = await withStore(config, (store) => importPythonCache(oldPath, store));
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
}

/**
 * check-browser: the server's browser setup against live Shironet: the home page, a plain
 * search, and two searches with ASCII quotes (the open firewall question). Then the leak
 * check. Uses the same pace minimum as the worker. Prints one line per page.
 */
async function checkBrowserCommand(): Promise<number> {
  const config = loadConfig();
  if (await serverAnswers(config)) {
    console.error('Stop the server first: check-browser uses the same browser setup and data dir.');
    return 1;
  }
  mkdirSync(config.dataDir, { recursive: true });
  const release = acquireLock(config.dataDir); // no server or import may start meanwhile
  try {
    const urls: Array<[string, string]> = [
      ['home', `${BASE_URL}/`],
      ['search', searchUrl('שיר לשלום')],
      ['quotes "', searchUrl('צה"ל')],
      ["quotes '", searchUrl("ג'ירפה")],
    ];
    let failures = 0;
    const session = await openChromeSession({ chromePath: config.chromePath, dataDir: config.dataDir }, consoleLogger);
    try {
      const signal = new AbortController().signal;
      for (const [index, [label, url]] of urls.entries()) {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, config.pace.startInterval * 1000));
        try {
          const page = await session.navigateAndExtract(url, signal);
          const state = page.challenge ? 'CHALLENGE' : page.lyrics ? 'lyrics' : `ok, ${page.links.length / 2} results`;
          if (page.challenge) failures += 1;
          console.log(`${label.padEnd(9)} ${state.padEnd(16)} ${page.title}`);
        } catch (error) {
          failures += 1;
          console.log(`${label.padEnd(9)} ERROR            ${(error as Error).message}`);
        }
      }
    } finally {
      const pid = session.pid;
      const report = await session.close('check-browser done');
      for (let i = 0; i < 50 && isAlive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const leak = isAlive(pid);
      console.log(`leak check: ${leak ? 'FAILED: the browser process is still running' : 'ok'} (close: ${report.how})`);
      if (leak) failures += 1;
    }
    return failures === 0 ? 0 : 1;
  } finally {
    release();
  }
}

const COMMANDS: Record<string, Command> = {
  serve,
  import: importCommand,
  status: statusCommand,
  'requeue-not-found': requeueCommand,
  'enqueue-calibration': calibrateCommand,
  'check-browser': checkBrowserCommand,
};

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
