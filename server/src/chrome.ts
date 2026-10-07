// Launches Chrome for one browser session and enforces the leak rules (spec: "Browser
// resources: no leaks"): a record file before launch, an ordered close (CDP close, wait,
// kill the whole tree, delete the profile with retries), and recovery after a crash.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { CdpConnection } from './cdp.ts';
import type { Logger } from './notifier.ts';
import { isAlive, killTree, listProcesses } from './processes.ts';

export const PROFILE_PREFIX = 'browser-profile-';
export const RECORD_FILE = 'browser.json';

export interface LaunchOptions {
  chromePath: string;
  dataDir: string;
  /** Arguments before Chrome's own (the tests run a fake Chrome script through node). */
  prefixArgs?: string[];
  startTimeoutMs?: number;
}

export interface CloseReport {
  how: 'clean' | 'killed' | 'already_exited';
  profileRemoved: boolean;
}

interface BrowserRecord {
  pid: number;
  start: string | null;
  profile: string;
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

/** Deletes a folder, retrying while Windows still holds files in it. False when it stays. */
export async function removeWithRetries(path: string, attempts = 10, delayMs = 500): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      if (!existsSync(path)) return true;
    } catch {
      // locked; try again
    }
    await sleep(delayMs);
  }
  return !existsSync(path);
}

export class ChromeProcess {
  readonly pid: number;
  readonly profile: string;
  readonly browserWsUrl: string;
  readonly startedAt: number;
  private readonly child: ChildProcess;
  private readonly dataDir: string;
  private readonly log: Logger;
  private exited = false;

  private constructor(child: ChildProcess, profile: string, browserWsUrl: string, dataDir: string, log: Logger) {
    this.child = child;
    this.pid = child.pid!;
    this.profile = profile;
    this.browserWsUrl = browserWsUrl;
    this.dataDir = dataDir;
    this.log = log;
    this.startedAt = Date.now();
    child.on('exit', () => { this.exited = true; });
    if (child.exitCode !== null) this.exited = true;
  }

  static async launch(options: LaunchOptions, log: Logger): Promise<ChromeProcess> {
    const profile = mkdtempSync(join(options.dataDir, PROFILE_PREFIX));
    const port = await freePort();
    const args = [
      ...(options.prefixArgs ?? []), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, ...CHROME_FLAGS, 'about:blank',
    ];
    // Linux: its own process group, so the whole tree can be killed at once.
    const child = spawn(options.chromePath, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => reject(new Error(`Cannot start ${options.chromePath}: ${error.message}`)));
    }).catch((error: Error) => {
      rmSync(profile, { recursive: true, force: true });
      throw error;
    });
    const start = (await listProcesses()).find((info) => info.pid === child.pid)?.start ?? null;
    const record: BrowserRecord = { pid: child.pid!, start, profile };
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
    const chrome = new ChromeProcess(child, profile, wsUrl ?? '', options.dataDir, log);
    if (!wsUrl) {
      await chrome.close(null);
      throw new Error(`Chrome did not open its debugging port within the start timeout (${options.chromePath})`);
    }
    log.info({ pid: chrome.pid, profile }, 'browser started');
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

  /** The close sequence: CDP close, wait up to 5 s, kill the tree, delete the profile and the record. */
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
    // After a clean exit, renderers may outlive the main process for a moment; the profile
    // removal below retries until they are gone and release their files.
    const profileRemoved = await removeWithRetries(this.profile);
    if (!profileRemoved) this.log.warn({ profile: this.profile }, 'browser profile left behind; the next start removes it');
    rmSync(join(this.dataDir, RECORD_FILE), { force: true });
    this.log.info({ pid: this.pid, how, profileRemoved }, 'browser closed');
    return { how, profileRemoved };
  }
}

/**
 * After a crash of the server: kill the Chrome named in the record, when its PID still runs
 * with the same start time (a reused PID is never touched), then delete every profile
 * folder and the record. Runs at start and before every launch.
 */
export async function recoverLeftovers(dataDir: string, log: Logger): Promise<{ killedPid: number | null; removed: string[]; left: string[] }> {
  let killedPid: number | null = null;
  const recordPath = join(dataDir, RECORD_FILE);
  if (existsSync(recordPath)) {
    try {
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as BrowserRecord;
      if (record.start && isAlive(record.pid)) {
        const running = (await listProcesses()).find((info) => info.pid === record.pid);
        if (running && running.start === record.start) {
          await killTree(record.pid);
          killedPid = record.pid;
          log.warn({ pid: record.pid }, 'killed a browser left over from a crash');
        }
      }
    } catch (error) {
      log.warn({ err: error }, 'unreadable browser record');
    }
  }
  const removed: string[] = [];
  const left: string[] = [];
  const names = existsSync(dataDir) ? readdirSync(dataDir) : [];
  for (const name of names.filter((n) => n.startsWith(PROFILE_PREFIX))) {
    const path = join(dataDir, name);
    if (await removeWithRetries(path, killedPid ? 10 : 3, 300)) removed.push(path);
    else left.push(path);
  }
  if (left.length > 0) log.warn({ left }, 'browser profiles still locked; they are removed on the next start');
  rmSync(recordPath, { force: true });
  return { killedPid, removed, left };
}
