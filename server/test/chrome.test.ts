import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeProcess, PROFILE_PREFIX, RECORD_FILE, recoverLeftovers, removeWithRetries } from '../src/chrome.ts';
import { isAlive, listProcesses } from '../src/processes.ts';
import { silentLogger } from '../src/notifier.ts';

const FAKE_CHROME = join(import.meta.dirname, 'fixtures', 'fake-chrome.mjs');

function launchFake(dataDir: string) {
  return ChromeProcess.launch({ chromePath: process.execPath, prefixArgs: [FAKE_CHROME], dataDir, startTimeoutMs: 10_000 }, silentLogger);
}
function rendererPid(profile: string): number {
  return JSON.parse(readFileSync(join(profile, 'children.json'), 'utf8')).renderer;
}
async function eventually(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out: ${what}`);
}

describe('processes', () => {
  test('the process list has this process with its parent', async () => {
    const me = (await listProcesses()).find((p) => p.pid === process.pid);
    assert.ok(me);
    assert.equal(me.ppid, process.ppid);
    assert.ok(me.start.length > 0);
  });
});

describe('ChromeProcess leak rules (fake Chrome)', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'chrome-test-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  test('launch reads the debug port and writes the browser record', async () => {
    const chrome = await launchFake(dataDir);
    try {
      assert.match(chrome.browserWsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/fake-id$/);
      assert.doesNotMatch(chrome.browserWsUrl, /:0\//); // never port 0: it sets navigator.webdriver
      assert.ok(chrome.profile.startsWith(join(dataDir, PROFILE_PREFIX)));
      const record = JSON.parse(readFileSync(join(dataDir, RECORD_FILE), 'utf8'));
      assert.equal(record.pid, chrome.pid);
      assert.equal(record.profile, chrome.profile);
      assert.ok(record.start);
    } finally {
      await chrome.close(null);
    }
  });
  test('close without CDP kills the whole tree and deletes the profile and the record', async () => {
    const chrome = await launchFake(dataDir);
    const renderer = rendererPid(chrome.profile);
    const report = await chrome.close(null);
    assert.equal(report.how, 'killed');
    assert.equal(report.profileRemoved, true);
    await eventually(() => !isAlive(chrome.pid) && !isAlive(renderer), 'both processes gone');
    assert.equal(existsSync(chrome.profile), false);
    assert.equal(existsSync(join(dataDir, RECORD_FILE)), false);
  });
  test('three sessions in a row leave no process and no folder', async () => {
    const pids: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const chrome = await launchFake(dataDir);
      pids.push(chrome.pid, rendererPid(chrome.profile));
      await chrome.close(null);
    }
    await eventually(() => pids.every((pid) => !isAlive(pid)), 'all processes gone');
    assert.deepEqual(readdirSync(dataDir).filter((name) => name.startsWith(PROFILE_PREFIX)), []);
  });
  test('after a server crash, the next start kills the leftover Chrome and deletes its profile', async () => {
    const leftover = await launchFake(dataDir); // never closed: the server "died"
    const renderer = rendererPid(leftover.profile);
    const result = await recoverLeftovers(dataDir, silentLogger);
    assert.equal(result.killedPid, leftover.pid);
    await eventually(() => !isAlive(leftover.pid) && !isAlive(renderer), 'leftover tree gone');
    assert.deepEqual(result.left, []);
    assert.equal(existsSync(leftover.profile), false);
    assert.equal(existsSync(join(dataDir, RECORD_FILE)), false);
  });
  test('a record whose PID now belongs to another process is never killed', async () => {
    // This test process is alive, but its start time does not match the record.
    writeFileSync(join(dataDir, RECORD_FILE), JSON.stringify({ pid: process.pid, start: 'not-my-start-time', profile: join(dataDir, `${PROFILE_PREFIX}old`) }));
    mkdirSync(join(dataDir, `${PROFILE_PREFIX}old`));
    const result = await recoverLeftovers(dataDir, silentLogger);
    assert.equal(result.killedPid, null);
    assert.equal(isAlive(process.pid), true);
    assert.deepEqual(result.removed, [join(dataDir, `${PROFILE_PREFIX}old`)]);
  });
  test('removeWithRetries: a missing path counts as removed', async () => {
    assert.equal(await removeWithRetries(join(dataDir, 'missing'), 3, 10), true);
  });
  test('a folder that Windows still locks: retries, then false, without throwing', { skip: process.platform !== 'win32' }, async () => {
    // A file held open without sharing, like Chrome's own files: Windows refuses to delete it.
    // (Being another process's working folder is not enough on Windows 11.)
    const locked = join(dataDir, `${PROFILE_PREFIX}locked`);
    mkdirSync(locked);
    const file = join(locked, 'Cookies');
    writeFileSync(file, 'x');
    const holder = spawn('powershell', ['-NoProfile', '-Command',
      `$f = [System.IO.File]::Open('${file}', 'Open', 'Read', 'None'); 'ready'; Start-Sleep -Seconds 60`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve) => holder.stdout!.on('data', (data: Buffer) => { if (data.toString().includes('ready')) resolve(); }));
    try {
      assert.equal(await removeWithRetries(locked, 3, 10), false);
      assert.equal(existsSync(locked), true);
    } finally {
      holder.kill();
      await new Promise((resolve) => holder.once('exit', resolve));
    }
    assert.equal(await removeWithRetries(locked, 10, 100), true);
  });
});
