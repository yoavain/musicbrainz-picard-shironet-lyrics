import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { BODY_LIMIT, buildApp } from '../src/api.ts';
import { LyricsService } from '../src/service.ts';
import { Store } from '../src/store.ts';

const HOST = '127.0.0.1:8735';
const SONG = { artist: 'דן תורן', title: 'אוטו כחול' };

/** JSON with every non-ASCII character written as a \u escape. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

describe('API', () => {
  let store: Store;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = new Store(':memory:');
    const service = new LyricsService(store, () => new Date(Date.UTC(2026, 9, 6, 12)));
    app = buildApp({ service, allowedHosts: [HOST, 'localhost:8735'], version: '9.9.9' });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    store.close();
  });

  function send(method: 'POST' | 'PUT', url: string, payload: string | Buffer, contentType = 'application/json; charset=utf-8') {
    return app.inject({ method, url, payload, headers: { host: HOST, 'content-type': contentType } });
  }
  function sendJson(method: 'POST' | 'PUT', url: string, body: unknown) {
    return send(method, url, JSON.stringify(body));
  }

  test('health answers the version', async () => {
    const reply = await app.inject({ method: 'GET', url: '/health', headers: { host: HOST } });
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(reply.json(), { ok: true, version: '9.9.9', commit: null, schemaVersion: null });
  });
  test('health answers the release commit and the schema version', async () => {
    await app.close();
    app = buildApp({ service: new LyricsService(store), allowedHosts: [HOST], version: '9.9.9', commit: 'abc1234', schemaVersion: 1 });
    await app.ready();
    const reply = await app.inject({ method: 'GET', url: '/health', headers: { host: HOST } });
    assert.deepEqual(reply.json(), { ok: true, version: '9.9.9', commit: 'abc1234', schemaVersion: 1 });
  });
  test('a foreign Host header is refused', async () => {
    const reply = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example:8735' } });
    assert.equal(reply.statusCode, 403);
  });
  test('localhost is allowed', async () => {
    const reply = await app.inject({ method: 'GET', url: '/health', headers: { host: 'localhost:8735' } });
    assert.equal(reply.statusCode, 200);
  });
  test('text/plain is refused (no CSRF from web pages)', async () => {
    const reply = await send('POST', '/lyrics/lookup', JSON.stringify(SONG), 'text/plain');
    assert.equal(reply.statusCode, 415);
  });
  test('application/json without charset is accepted', async () => {
    const reply = await send('POST', '/lyrics/lookup', JSON.stringify(SONG), 'application/json');
    assert.equal(reply.statusCode, 404);
  });
  test('a UTF-8 BOM before the body is accepted', async () => {
    const body = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(JSON.stringify(SONG), 'utf8')]);
    const reply = await send('POST', '/lyrics/lookup', body);
    assert.equal(reply.statusCode, 404);
  });
  test('a body that is not valid UTF-8 is refused', async () => {
    const body = Buffer.concat([Buffer.from('{"artist":"', 'utf8'), Buffer.from([0xFF, 0xFE]), Buffer.from('","title":"x"}', 'utf8')]);
    const reply = await send('POST', '/lyrics/lookup', body);
    assert.equal(reply.statusCode, 400);
  });
  test('a lone surrogate is refused', async () => {
    const reply = await send('POST', '/lyrics/lookup', '{"artist":"\\ud800","title":"x"}');
    assert.equal(reply.statusCode, 400);
  });
  test('control characters in a name are refused', async () => {
    const reply = await sendJson('POST', '/lyrics/lookup', { artist: 'a\u0007', title: 'x' });
    assert.equal(reply.statusCode, 400);
  });
  test('unknown fields are refused', async () => {
    const reply = await sendJson('POST', '/lyrics/lookup', { ...SONG, extra: 1 });
    assert.equal(reply.statusCode, 400);
  });
  test('a body over the limit answers 413 and the server keeps serving', async () => {
    const lyrics = 'א'.repeat(BODY_LIMIT); // 2 bytes each in UTF-8
    const reply = await sendJson('PUT', '/lyrics', { ...SONG, lyrics });
    assert.equal(reply.statusCode, 413);
    const health = await app.inject({ method: 'GET', url: '/health', headers: { host: HOST } });
    assert.equal(health.statusCode, 200);
  });
  test('lyrics just under the limit are accepted', async () => {
    const lyrics = 'שורה\n'.repeat(20_000); // about 180 KB in UTF-8
    const reply = await sendJson('PUT', '/lyrics', { ...SONG, lyrics });
    assert.equal(reply.statusCode, 200);
    assert.equal(reply.json().result, 'added');
  });
  test('raw and escaped Hebrew give the same song', async () => {
    const put = await send('PUT', '/lyrics', JSON.stringify({ ...SONG, lyrics: 'שורה' }));
    assert.equal(put.json().result, 'added');
    const lookup = await send('POST', '/lyrics/lookup', asciiJson(SONG));
    assert.equal(lookup.statusCode, 200);
    assert.equal(lookup.json().lyrics, 'שורה');
  });
  test('special characters round-trip byte for byte', async () => {
    const title = 'אחד+אחד & ? # / " \' ׳ ״ ־ שִׁיר\u200F';
    const lyrics = 'שורה עם "מרכאות" ו־מקף\nשורה\u200F שנייה';
    await sendJson('PUT', '/lyrics', { artist: 'אמן', title, lyrics });
    const reply = await sendJson('POST', '/lyrics/lookup', { artist: 'אמן', title });
    assert.equal(reply.statusCode, 200);
    assert.match(String(reply.headers['content-type']), /application\/json; charset=utf-8/);
    assert.equal(reply.json().title, title);
    assert.equal(reply.json().lyrics, lyrics);
  });
  test('a direction mark in a name finds the same song', async () => {
    await sendJson('PUT', '/lyrics', { artist: 'אמן', title: 'שיר\u200F', lyrics: 'שורה' });
    const reply = await sendJson('POST', '/lyrics/lookup', { artist: 'אמן', title: 'שיר' });
    assert.equal(reply.statusCode, 200);
  });
  test('fetch answers 202, 200, 404 and 422', async () => {
    const queued = await sendJson('POST', '/lyrics/fetch', { ...SONG, priority: 'interactive' });
    assert.equal(queued.statusCode, 202);
    assert.deepEqual(queued.json(), { status: 'queued', position: 1 });

    await sendJson('PUT', '/lyrics', { artist: 'אמן', title: 'שיר', lyrics: 'שורה' });
    const found = await sendJson('POST', '/lyrics/fetch', { artist: 'אמן', title: 'שיר' });
    assert.equal(found.statusCode, 200);
    assert.deepEqual(found.json(), { status: 'found', lyrics: 'שורה', source: 'embedded', artist: 'אמן', title: 'שיר' });

    store.db.prepare("UPDATE queue SET status = 'not_found', retry_after = '2026-10-13T12:00:00+00:00'").run();
    const missed = await sendJson('POST', '/lyrics/fetch', SONG);
    assert.equal(missed.statusCode, 404);
    assert.deepEqual(missed.json(), { status: 'not_found', retryAfter: '2026-10-13T12:00:00+00:00' });

    const english = await sendJson('POST', '/lyrics/fetch', { artist: 'R.E.M.', title: 'The One I Love' });
    assert.equal(english.statusCode, 422);
    assert.deepEqual(english.json(), { status: 'not_hebrew' });

    const noName = await sendJson('POST', '/lyrics/fetch', { artist: '!!!', title: '\u200F' });
    assert.equal(noName.statusCode, 422);
    assert.deepEqual(noName.json(), { status: 'no_name' });
  });
  test('a bad priority is refused', async () => {
    const reply = await sendJson('POST', '/lyrics/fetch', { ...SONG, priority: 'urgent' });
    assert.equal(reply.statusCode, 400);
  });
  test('put answers each result', async () => {
    const first = await sendJson('PUT', '/lyrics', { ...SONG, lyrics: 'שורה', ref: '/a.mp3' });
    assert.deepEqual(first.json(), { result: 'added' });
    const conflict = await sendJson('PUT', '/lyrics', { ...SONG, lyrics: 'אחרת', ref: '/b.mp3' });
    assert.deepEqual(conflict.json(), { result: 'conflict' });
    const replaced = await sendJson('PUT', '/lyrics', { ...SONG, lyrics: 'אחרת', ref: '/b.mp3', replace: true });
    assert.deepEqual(replaced.json(), { result: 'replaced' });
    const english = await sendJson('PUT', '/lyrics', { artist: 'Band', title: 'Song', lyrics: 'English words' });
    assert.deepEqual(english.json(), { result: 'not_hebrew' });
  });
  test('put without lyrics is refused', async () => {
    const reply = await sendJson('PUT', '/lyrics', SONG);
    assert.equal(reply.statusCode, 400);
  });
  test('fetch answers 202 fetching while the worker has the song', async () => {
    await app.close();
    const service = new LyricsService(store, () => new Date(Date.UTC(2026, 9, 6, 12)), {
      inFlight: () => ({ artistKey: 'דן תורן', titleKey: 'אוטו כחול' }),
    });
    app = buildApp({ service, allowedHosts: [HOST], version: '9.9.9' });
    await app.ready();
    await sendJson('POST', '/lyrics/fetch', SONG);
    const reply = await sendJson('POST', '/lyrics/fetch', SONG);
    assert.equal(reply.statusCode, 202);
    assert.deepEqual(reply.json(), { status: 'fetching' });
  });
  test('admin: requeue-not-found and calibrate', async () => {
    await sendJson('POST', '/lyrics/fetch', SONG);
    store.db.prepare("UPDATE queue SET status = 'not_found', retry_after = '2026-10-13T12:00:00+00:00'").run();
    const requeued = await sendJson('POST', '/admin/requeue-not-found', {});
    assert.deepEqual(requeued.json(), { count: 1 });
    await sendJson('PUT', '/lyrics', { artist: 'אמן', title: 'מוכר', lyrics: 'שורה' });
    const calibrated = await sendJson('POST', '/admin/calibrate', { count: 3 });
    assert.deepEqual(calibrated.json(), { queued: 1 });
    const bad = await sendJson('POST', '/admin/calibrate', { count: 0 });
    assert.equal(bad.statusCode, 400);
  });
  test('no Fastify deprecation warning at start', async () => {
    const codes: string[] = [];
    const listen = (warning: Error & { code?: string }) => { codes.push(warning.code ?? warning.name); };
    process.on('warning', listen);
    try {
      const other = buildApp({ service: new LyricsService(store), allowedHosts: [HOST], version: '9.9.9' });
      await other.ready();
      await other.close();
      await new Promise((resolve) => setImmediate(resolve)); // warnings are emitted on the next tick
    } finally {
      process.off('warning', listen);
    }
    assert.deepEqual(codes.filter((code) => code.startsWith('FSTDEP')), []);
  });
  test('per-request log lines are debug, not info', async () => {
    await app.close();
    const lines: string[] = [];
    app = buildApp({
      service: new LyricsService(store), allowedHosts: [HOST], version: '9.9.9',
      logger: { level: 'info', stream: { write: (line: string) => { lines.push(line); } } },
    });
    await app.ready();
    await app.inject({ method: 'GET', url: '/health', headers: { host: HOST } });
    assert.deepEqual(lines.filter((line) => line.includes('/health')), []);
  });
  test('status', async () => {
    await sendJson('POST', '/lyrics/fetch', SONG);
    const reply = await app.inject({ method: 'GET', url: '/status', headers: { host: HOST } });
    assert.deepEqual(reply.json(), {
      lyrics: 0, due: 1, queue: [{ purpose: 'fetch', status: 'pending', priority: 'bulk', count: 1 }],
    });
  });
});

describe('API with a token', () => {
  const TOKEN = 'test-token-0123456789-abcdef';
  const LAN = 'lyrics.example.home:8735';
  let store: Store;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = new Store(':memory:');
    app = buildApp({ service: new LyricsService(store), allowedHosts: [HOST, LAN], version: '9.9.9', apiToken: TOKEN });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    store.close();
  });

  function lookup(authorization?: string) {
    const headers: Record<string, string> = { host: LAN, 'content-type': 'application/json; charset=utf-8' };
    if (authorization !== undefined) headers.authorization = authorization;
    return app.inject({ method: 'POST', url: '/lyrics/lookup', payload: JSON.stringify(SONG), headers });
  }

  test('a route without the token, or with a wrong one, answers 401', async () => {
    for (const authorization of [undefined, '', 'Bearer', `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, TOKEN]) {
      const reply = await lookup(authorization);
      assert.equal(reply.statusCode, 401, `authorization: ${authorization}`);
      assert.deepEqual(reply.json(), { error: 'Unauthorized' });
      assert.equal(reply.headers['www-authenticate'], 'Bearer');
    }
    const status = await app.inject({ method: 'GET', url: '/status', headers: { host: LAN } });
    assert.equal(status.statusCode, 401);
  });
  test('the right token passes (the scheme in any case)', async () => {
    assert.equal((await lookup(`Bearer ${TOKEN}`)).statusCode, 404); // missing: past the check
    assert.equal((await lookup(`bearer ${TOKEN}`)).statusCode, 404);
  });
  test('health stays open', async () => {
    const reply = await app.inject({ method: 'GET', url: '/health', headers: { host: LAN } });
    assert.equal(reply.statusCode, 200);
  });
  test('the host check runs first', async () => {
    const reply = await app.inject({ method: 'GET', url: '/status', headers: { host: 'evil.example', authorization: `Bearer ${TOKEN}` } });
    assert.equal(reply.statusCode, 403);
  });
});
