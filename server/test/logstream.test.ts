import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogStream } from '../src/logstream.ts';

describe('log stream', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'log-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('writes each line to the file and echoes it, in UTF-8', () => {
    const echoed: string[] = [];
    const log = createLogStream(join(dir, 'server.log'), { echo: { write: (t) => echoed.push(t) } });
    log.write('{"msg":"שיר"}\n');
    log.close();
    assert.equal(readFileSync(join(dir, 'server.log'), 'utf8'), '{"msg":"שיר"}\n');
    assert.deepEqual(echoed, ['{"msg":"שיר"}\n']);
  });
  test('rotates by size and keeps a fixed number of files, losing no line', () => {
    const path = join(dir, 'server.log');
    const log = createLogStream(path, { maxBytes: 100, files: 3, echo: { write: () => true } });
    const lines = Array.from({ length: 30 }, (_, i) => `line ${String(i).padStart(2, '0')} ${'x'.repeat(20)}\n`);
    for (const line of lines) log.write(line);
    log.close();
    assert.equal(existsSync(`${path}.1`), true);
    assert.equal(existsSync(`${path}.2`), true);
    assert.equal(existsSync(`${path}.3`), false);
    const kept = [readFileSync(`${path}.2`, 'utf8'), readFileSync(`${path}.1`, 'utf8'), readFileSync(path, 'utf8')].join('');
    assert.ok(kept.endsWith(lines.slice(-6).join('')), 'the newest lines are all there, in order');
    assert.ok(readFileSync(path, 'utf8').length <= 100);
  });
  test('appends to an existing file after a restart', () => {
    const path = join(dir, 'server.log');
    const first = createLogStream(path, { echo: { write: () => true } });
    first.write('a\n');
    first.close();
    const second = createLogStream(path, { echo: { write: () => true } });
    second.write('b\n');
    second.close();
    assert.equal(readFileSync(path, 'utf8'), 'a\nb\n');
  });
});
