// Launches Chrome and enforces the process side of the leak rules (spec: "Browser
// resources: no leaks"): a record file before launch, an ordered close (CDP close, wait,
// kill the whole tree), and recovery after a crash.
//
// Chrome runs on one fixed user data folder, <data dir>/browser, which Chrome itself
// manages. The server never deletes Chrome's files. Visits never reach that folder: each
// session browses in a fresh incognito context (reader.ts), which lives in memory only.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { CdpConnection } from './cdp.ts';
import type { Logger } from './notifier.ts';
import { isAlive, killTree, listProcesses } from './processes.ts';

export const BROWSER_DIR = 'browser';
export const RECORD_FILE = 'browser.json';

export interface LaunchOptions {
  chromePath: string;
  dataDir: string;
  /** Arguments before Chrome's own (the tests run a fake Chrome script through node). */
  prefixArgs?: string[];
  /** More Chrome flags from the config (browser.extraArgs). */
  extraArgs?: readonly string[];
  startTimeoutMs?: number;
}

export interface CloseReport {
  how: 'clean' | 'killed' | 'already_exited';
}

interface BrowserRecord {
  pid: number;
  start: string | null;
}

// A normal launch: no --headless, no --enable-automation, nothing patched. Each flag here
// was checked with check-browser; a new flag must be too, since it could change what
// Radware sees. The debugging port is a fixed free port that we pick: Chrome Dev sets
// navigator.webdriver = true for --remote-debugging-port=0 (measured 2026-10-07; a fixed
// port gives false, and test-browser checks it).
const CHROME_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-extensions',
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A free TCP port on 127.0.0.1, for Chrome's debugging endpoint. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export class ChromeProcess {
  readonly pid: number;
  readonly userDataDir: string;
  readonly browserWsUrl: string;
  readonly startedAt: number;
  private readonly dataDir: string;
  private readonly log: Logger;
  private exited = false;

  private constructor(child: ChildProcess, userDataDir: string, browserWsUrl: string, dataDir: string, log: Logger) {
    this.pid = child.pid!;
    this.userDataDir = userDataDir;
    this.browserWsUrl = browserWsUrl;
    this.dataDir = dataDir;
    this.log = log;
    this.startedAt = Date.now();
    child.on('exit', () => { this.exited = true; });
    if (child.exitCode !== null) this.exited = true;
  }

  static async launch(options: LaunchOptions, log: Logger): Promise<ChromeProcess> {
    const userDataDir = join(options.dataDir, BROWSER_DIR);
    mkdirSync(userDataDir, { recursive: true });
    const port = await freePort();
    const args = [
      ...(options.prefixArgs ?? []), `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`, ...CHROME_FLAGS, ...(options.extraArgs ?? []), 'about:blank',
    ];
    // Linux: its own process group, so the whole tree can be killed at once.
    const child = spawn(options.chromePath, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => reject(new Error(`Cannot start ${options.chromePath}: ${error.message}`)));
    });
    const start = (await listProcesses()).find((info) => info.pid === child.pid)?.start ?? null;
    const record: BrowserRecord = { pid: child.pid!, start };
    writeFileSync(join(options.dataDir, RECORD_FILE), JSON.stringify(record));

    // With a fixed port Chrome does not reliably write DevToolsActivePort: ask its HTTP endpoint.
    const deadline = Date.now() + (options.startTimeoutMs ?? 20_000);
    let wsUrl: string | null = null;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const reply = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
        const version = (await reply.json()) as { webSocketDebuggerUrl?: string };
        if (version.webSocketDebuggerUrl) {
          wsUrl = version.webSocketDebuggerUrl;
          break;
        }
      } catch {
        // not listening yet
      }
      await sleep(200);
    }
    const chrome = new ChromeProcess(child, userDataDir, wsUrl ?? '', options.dataDir, log);
    if (!wsUrl) {
      await chrome.close(null);
      // A Chrome that is already running on this folder takes the launch over and the new
      // process exits at once; recoverLeftovers() before each launch prevents that.
      throw new Error(`Chrome did not open its debugging port within the start timeout (${options.chromePath})`);
    }
    log.info({ browserPid: chrome.pid, userDataDir }, 'browser started');
    return chrome;
  }

  hasExited(): boolean {
    return this.exited;
  }

  private async waitForExit(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!this.exited && Date.now() < deadline) await sleep(50);
    return this.exited;
  }

  /** The close sequence: CDP close, wait up to 5 s, kill the whole tree, remove the record. */
  async close(cdp: CdpConnection | null): Promise<CloseReport> {
    let how: CloseReport['how'] = this.exited ? 'already_exited' : 'clean';
    if (!this.exited && cdp && !cdp.isClosed) {
      try {
        await cdp.send('Browser.close', {}, undefined, 3_000);
      } catch {
        // no answer: the kill below handles it
      }
    }
    cdp?.close();
    if (!(await this.waitForExit(cdp ? 5_000 : 0))) {
      how = 'killed';
      await killTree(this.pid);
      await this.waitForExit(5_000);
    }
    rmSync(join(this.dataDir, RECORD_FILE), { force: true });
    this.log.info({ browserPid: this.pid, how }, 'browser closed');
    return { how };
  }
}

/**
 * After a crash of the server: kill the Chrome named in the record, when its PID still runs
 * with the same start time (a reused PID is never touched). Runs at start and before every
 * launch, so a leftover Chrome cannot take over the next launch on the same folder.
 */
export async function recoverLeftovers(dataDir: string, log: Logger): Promise<{ killedPid: number | null }> {
  const recordPath = join(dataDir, RECORD_FILE);
  if (!existsSync(recordPath)) return { killedPid: null };
  let killedPid: number | null = null;
  try {
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as BrowserRecord;
    if (record.start && isAlive(record.pid)) {
      const running = (await listProcesses()).find((info) => info.pid === record.pid);
      if (running && running.start === record.start) {
        await killTree(record.pid);
        killedPid = record.pid;
        log.warn({ browserPid: record.pid }, 'killed a browser left over from a crash');
      }
    }
  } catch (error) {
    log.warn({ err: error }, 'unreadable browser record');
  }
  rmSync(recordPath, { force: true });
  return { killedPid };
}
