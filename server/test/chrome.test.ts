import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_DIR, ChromeProcess, RECORD_FILE, recoverLeftovers } from '../src/chrome.ts';
import { isAlive, listProcesses } from '../src/processes.ts';
import { silentLogger } from '../src/notifier.ts';

const FAKE_CHROME = join(import.meta.dirname, 'fixtures', 'fake-chrome.mjs');

function launchFake(dataDir: string) {
  return ChromeProcess.launch({ chromePath: process.execPath, prefixArgs: [FAKE_CHROME], dataDir, startTimeoutMs: 10_000 }, silentLogger);
}
function rendererPid(dataDir: string): number {
  return JSON.parse(readFileSync(join(dataDir, BROWSER_DIR, 'children.json'), 'utf8')).renderer;
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

describe('ChromeProcess (fake Chrome)', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'chrome-test-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  test('launch uses the fixed browser folder and a fixed port, and writes the record', async () => {
    const chrome = await launchFake(dataDir);
    try {
      assert.equal(chrome.userDataDir, join(dataDir, BROWSER_DIR));
      assert.match(chrome.browserWsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/fake-id$/);
      assert.doesNotMatch(chrome.browserWsUrl, /:0\//); // never port 0: it sets navigator.webdriver
      const record = JSON.parse(readFileSync(join(dataDir, RECORD_FILE), 'utf8'));
      assert.equal(record.pid, chrome.pid);
      assert.ok(record.start);
    } finally {
      await chrome.close(null);
    }
  });
  test('close without CDP kills the whole tree and removes the record; Chrome keeps its folder', async () => {
    const chrome = await launchFake(dataDir);
    const renderer = rendererPid(dataDir);
    const report = await chrome.close(null);
    assert.equal(report.how, 'killed');
    await eventually(() => !isAlive(chrome.pid) && !isAlive(renderer), 'both processes gone');
    assert.equal(existsSync(join(dataDir, RECORD_FILE)), false);
    assert.equal(existsSync(join(dataDir, BROWSER_DIR)), true); // the server never deletes Chrome's files
  });
  test('three sessions in a row leave no process', async () => {
    const pids: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const chrome = await launchFake(dataDir);
      pids.push(chrome.pid, rendererPid(dataDir));
      await chrome.close(null);
    }
    await eventually(() => pids.every((pid) => !isAlive(pid)), 'all processes gone');
  });
  test('after a server crash, the next start kills the leftover Chrome', async () => {
    const leftover = await launchFake(dataDir); // never closed: the server "died"
    const renderer = rendererPid(dataDir);
    const result = await recoverLeftovers(dataDir, silentLogger);
    assert.equal(result.killedPid, leftover.pid);
    await eventually(() => !isAlive(leftover.pid) && !isAlive(renderer), 'leftover tree gone');
    assert.equal(existsSync(join(dataDir, RECORD_FILE)), false);
  });
  test('a record whose PID now belongs to another process is never killed', async () => {
    // This test process is alive, but its start time does not match the record.
    writeFileSync(join(dataDir, RECORD_FILE), JSON.stringify({ pid: process.pid, start: 'not-my-start-time' }));
    const result = await recoverLeftovers(dataDir, silentLogger);
    assert.equal(result.killedPid, null);
    assert.equal(isAlive(process.pid), true);
    assert.equal(existsSync(join(dataDir, RECORD_FILE)), false);
  });
});
