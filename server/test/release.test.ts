import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_FILE, readRelease } from '../src/release.ts';

describe('readRelease', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'release-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('a working tree has no release file', () => {
    assert.deepEqual(readRelease(dir), { commit: null, time: null });
  });
  test('the deploy script writes commit and time', () => {
    writeFileSync(join(dir, RELEASE_FILE), JSON.stringify({ commit: 'abc1234def', time: '2026-10-07T12:00:00Z' }));
    assert.deepEqual(readRelease(dir), { commit: 'abc1234def', time: '2026-10-07T12:00:00Z' });
  });
  test('a broken file stops the start', () => {
    writeFileSync(join(dir, RELEASE_FILE), '{');
    assert.throws(() => readRelease(dir), /release\.json/);
    writeFileSync(join(dir, RELEASE_FILE), JSON.stringify({ commit: 7 }));
    assert.throws(() => readRelease(dir), /release\.json/);
  });
});
