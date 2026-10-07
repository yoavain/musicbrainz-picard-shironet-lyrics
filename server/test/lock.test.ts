import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireLock, isLocked } from '../src/lock.ts';

const LOCK_MODULE = pathToFileURL(join(import.meta.dirname, '..', 'src', 'lock.ts')).href;

/** A separate Node process that takes the lock and keeps it until it is killed. */
function holdLockInChild(dir: string): Promise<{ kill: () => Promise<void> }> {
  const child = spawn(process.execPath, [
    '--input-type=module', '-e',
    `import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};
     acquireLock(${JSON.stringify(dir)}); console.log('locked'); setInterval(() => {}, 1000);`,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (data: Buffer) => {
      if (!data.toString().includes('locked')) return;
      resolve({
        kill: () => new Promise((done) => { child.on('exit', () => done()); child.kill('SIGKILL'); }),
      });
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`child exited early with ${code}`)));
  });
}

describe('lock', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lock-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('acquire, refuse a second holder, release, acquire again', () => {
    const release = acquireLock(dir);
    assert.equal(isLocked(dir), true);
    assert.throws(() => acquireLock(dir), /server\.lock/);
    release();
    assert.equal(isLocked(dir), false);
    acquireLock(dir)();
  });
  test('a data dir that does not exist yet is not locked', () => {
    assert.equal(isLocked(join(dir, 'missing')), false);
  });
  test('a leftover lock file naming a live, unrelated process does not block', () => {
    // An old-style PID file: this test process is alive but holds no lock.
    writeFileSync(join(dir, 'server.lock'), String(process.pid));
    const release = acquireLock(dir);
    release();
  });
  test('a lock held by another process blocks, and is free once that process is killed', async () => {
    const holder = await holdLockInChild(dir);
    let killed = false;
    try {
      assert.equal(isLocked(dir), true);
      assert.throws(() => acquireLock(dir), /server\.lock/);
      await holder.kill();
      killed = true;
      acquireLock(dir)();
    } finally {
      if (!killed) await holder.kill();
    }
  });
});
