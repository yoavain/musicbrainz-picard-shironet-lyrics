import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/notifier.ts';
import type { Logger } from '../src/notifier.ts';

function capture(): { log: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const noop = () => {};
  return { warnings, log: { debug: noop, info: noop, error: noop, warn: (_obj, msg) => { warnings.push(msg ?? ''); } } };
}

describe('notifier', () => {
  test('ntfy is published as JSON, never through a header (Hebrew-safe)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const notifier = createNotifier({ windows: false, ntfyUrl: 'https://ntfy.example/lyrics-alerts', fetchFn });
    await notifier.notify('CAPTCHA', 'שיר: אוטו כחול');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://ntfy.example/');
    assert.equal((calls[0].init.headers as Record<string, string>)['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { topic: 'lyrics-alerts', title: 'CAPTCHA', message: 'שיר: אוטו כחול' });
  });
  test('Windows toast passes the text in environment variables', async () => {
    const spawned: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
    const spawnProcess = (command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawned.push({ command, env: options.env });
      return { on: () => undefined, unref: () => {} };
    };
    const notifier = createNotifier({ windows: true, ntfyUrl: null, platform: 'win32', spawnProcess });
    await notifier.notify('כותרת', 'הודעה');
    assert.equal(spawned[0].command, 'powershell');
    assert.deepEqual([spawned[0].env.SL_TITLE, spawned[0].env.SL_MESSAGE], ['כותרת', 'הודעה']);
  });
  test('no Windows toast on another platform', async () => {
    let spawned = 0;
    const spawnProcess = () => { spawned += 1; return { on: () => undefined, unref: () => {} }; };
    await createNotifier({ windows: true, ntfyUrl: null, platform: 'linux', spawnProcess }).notify('a', 'b');
    assert.equal(spawned, 0);
  });
  test('an ntfy failure is logged, not thrown', async () => {
    const { log, warnings } = capture();
    const fetchFn = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await createNotifier({ windows: false, ntfyUrl: 'https://ntfy.example/t', fetchFn, log }).notify('a', 'b');
    assert.equal(warnings.length, 1);
  });
});
