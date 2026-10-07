import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from '../src/worker.ts';
import type { Clock, PageReader } from '../src/worker.ts';
import type { RequestResult } from '../src/fetcher.ts';
import { DEFAULT_LIMITS, Pacer, initialState, loadPace } from '../src/pacer.ts';
import { silentLogger } from '../src/notifier.ts';
import type { Notifier } from '../src/notifier.ts';
import { BASE_URL, searchUrl } from '../src/shironet.ts';
import { SOURCE_EMBEDDED, Store } from '../src/store.ts';
import * as queue from '../src/queue.ts';
import { enqueueCalibration, fetchesSinceSample } from '../src/calibration.ts';

const START = Date.UTC(2026, 9, 7, 12);
const LYRICS_URL = `${BASE_URL}/artist?type=lyrics&lang=1&prfid=578&wrkid=3005`;
const HREF = '/artist?type=lyrics&lang=1&prfid=578&wrkid=3005';

/** Virtual time: sleep advances the clock at once, then yields to the event loop. */
class FakeClock implements Clock {
  time = START;
  now() { return this.time; }
  async sleep(ms: number, signal: AbortSignal) {
    if (!signal.aborted) this.time += ms;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function okSearch(title: string, artist: string): RequestResult {
  return { outcome: 'ok', page: { url: '', title: '', challenge: false, links: [{ text: title, href: HREF }, { text: artist, href: '/artist?prfid=1' }], lyrics: null } };
}
function okLyrics(text: string): RequestResult {
  return { outcome: 'ok', page: { url: LYRICS_URL, title: '', challenge: false, links: [], lyrics: { song: 's', singer: 'a', text } } };
}

/** A scripted browser. Answers by URL (a list answers in order). */
class FakeReader implements PageReader {
  calls: Array<{ url: string; at: number }> = [];
  open = false;
  closed: string[] = [];
  solve = false;
  /** waitForHuman gives up at once (window closed, Chrome crashed). */
  giveUpAtOnce = false;
  /** URLs whose read rejects (a CDP failure, not a stop). */
  throwing = new Set<string>();
  hold: { url: string; release: () => void } | null = null;
  private readonly clock: FakeClock;
  private readonly answers: Record<string, RequestResult | RequestResult[]>;
  // No constructor parameter properties: Node's type stripping refuses them.
  constructor(clock: FakeClock, answers: Record<string, RequestResult | RequestResult[]>) {
    this.clock = clock;
    this.answers = answers;
  }
  async read(url: string, signal: AbortSignal): Promise<RequestResult> {
    this.open = true;
    this.calls.push({ url, at: this.clock.now() });
    if (this.throwing.has(url)) throw new Error(`CDP failure on ${url}`);
    if (this.hold?.url === url) {
      await new Promise<void>((resolve) => { this.hold!.release = resolve; signal.addEventListener('abort', () => resolve()); });
      return { outcome: 'error', detail: 'aborted' };
    }
    const answer = this.answers[url];
    if (!answer) return { outcome: 'error', detail: `no answer for ${url}` };
    return Array.isArray(answer) ? (answer.length > 1 ? answer.shift()! : answer[0]) : answer;
  }
  async waitForHuman(timeoutMs: number, signal: AbortSignal) {
    if (this.giveUpAtOnce) return false;
    await this.clock.sleep(this.solve ? 1000 : timeoutMs, signal);
    return this.solve;
  }
  isOpen() { return this.open; }
  async close(reason: string) { this.open = false; this.closed.push(reason); }
  status() { return { open: this.open }; }
}

async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 20000; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('Worker', () => {
  let store: Store;
  let clock: FakeClock;
  let notes: string[];
  let notifier: Notifier;
  let worker: Worker | null;

  beforeEach(() => {
    store = new Store(':memory:');
    clock = new FakeClock();
    notes = [];
    notifier = { notify: async (title: string) => { notes.push(title); } };
    worker = null;
  });
  afterEach(async () => {
    await worker?.stop();
    store.close();
  });

  function make(reader: PageReader, options = {}) {
    worker = new Worker({
      store, reader, notifier, log: silentLogger, clock, options,
      pacer: new Pacer(loadPace(store, DEFAULT_LIMITS), DEFAULT_LIMITS, () => 0.5),
    });
    return worker;
  }
  function enqueue(title: string, priority: queue.Priority = 'bulk') {
    queue.insert(store, [{ artist: 'להקה', title }], priority, '2026-10-07T10:00:00+00:00');
  }

  test('fetches a queued song, with at least the minimum gap between requests', async () => {
    enqueue('שיר');
    const reader = new FakeReader(clock, { [searchUrl('שיר')]: okSearch('שיר', 'להקה'), [LYRICS_URL]: okLyrics('שורה') });
    make(reader).start();
    await until(() => store.count() === 1, 'song stored');
    assert.equal(store.get('להקה', 'שיר')?.lyrics, 'שורה');
    assert.ok(reader.calls[1].at - reader.calls[0].at >= 5000);
    assert.equal(queue.recentRequests(store, 10).length, 2);
  });
  test('a solved CAPTCHA: notified, the song is retried, no attempt counted', async () => {
    enqueue('שיר');
    const reader = new FakeReader(clock, {
      [searchUrl('שיר')]: [{ outcome: 'challenge', detail: 'perfdrive' }, okSearch('שיר', 'להקה')],
      [LYRICS_URL]: okLyrics('שורה'),
    });
    reader.solve = true;
    make(reader).start();
    await until(() => store.count() === 1, 'song stored after the CAPTCHA');
    assert.deepEqual(notes, ['Shironet CAPTCHA']);
    assert.deepEqual(reader.closed, []);
    assert.equal(queue.find(store, [{ artist: 'להקה', title: 'שיר' }])?.attempts, 1); // only the success
  });
  test('an unsolved CAPTCHA closes the browser and waits out the cooldown', async () => {
    enqueue('שיר');
    const reader = new FakeReader(clock, {
      [searchUrl('שיר')]: [{ outcome: 'challenge', detail: 'perfdrive' }, okSearch('שיר', 'להקה')],
      [LYRICS_URL]: okLyrics('שורה'),
    });
    make(reader).start();
    await until(() => store.count() === 1, 'song stored after the cooldown');
    assert.equal(reader.closed.length, 1);
    assert.ok(reader.calls[1].at - reader.calls[0].at >= 1800_000);
  });
  test('stop between search and lyrics: pending, lyrics_url kept, no attempt; a new worker fetches only the lyrics page', async () => {
    enqueue('שיר');
    const reader = new FakeReader(clock, { [searchUrl('שיר')]: okSearch('שיר', 'להקה'), [LYRICS_URL]: okLyrics('שורה') });
    reader.hold = { url: LYRICS_URL, release: () => {} };
    const first = make(reader);
    first.start();
    await until(() => reader.calls.length === 2, 'lyrics page requested');
    assert.deepEqual(first.inFlight(), { artistKey: 'להקה', titleKey: 'שיר' });
    await first.stop();
    worker = null;
    const row = queue.find(store, [{ artist: 'להקה', title: 'שיר' }])!;
    assert.deepEqual([row.status, row.attempts, row.lyricsUrl], ['pending', 0, LYRICS_URL]);
    assert.deepEqual(reader.closed, ['server stopping']);

    const second = new FakeReader(clock, { [LYRICS_URL]: okLyrics('שורה') });
    make(second).start();
    await until(() => store.count() === 1, 'song stored by the new worker');
    assert.deepEqual(second.calls.map((c) => c.url), [LYRICS_URL]);
  });
  test('the pace survives a restart through meta', async () => {
    enqueue('שיר');
    const reader = new FakeReader(clock, {
      [searchUrl('שיר')]: [{ outcome: 'challenge', detail: 'perfdrive' }, okSearch('שיר', 'להקה')],
      [LYRICS_URL]: okLyrics('שורה'),
    });
    reader.solve = true;
    make(reader).start();
    await until(() => store.count() === 1, 'song stored');
    assert.equal(loadPace(store, DEFAULT_LIMITS).challenges.length, 1);
    assert.notDeepEqual(loadPace(store, DEFAULT_LIMITS), initialState(DEFAULT_LIMITS));
  });
  test('sampled calibration runs only while the browser is open; the counter is in meta', async () => {
    store.put('אמן', 'מוכר', 'שורה ראשונה', SOURCE_EMBEDDED);
    const sampleSearch = searchUrl('מוכר');
    enqueue('שיר');
    const reader = new FakeReader(clock, {
      [searchUrl('שיר')]: okSearch('שיר', 'להקה'), [LYRICS_URL]: okLyrics('שורה'),
      [sampleSearch]: okSearch('מוכר', 'אמן'),
    });
    make(reader, { calibrationEvery: 1 }).start();
    await until(() => (store.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE purpose = 'calibrate' AND status = 'done'").get() as { n: number }).n === 1, 'sample done');
    assert.equal(fetchesSinceSample(store), 0);
    assert.equal(store.get('אמן', 'מוכר')?.lyrics, 'שורה ראשונה'); // calibration stores nothing
  });
  test('no sample when the browser is closed; an on-demand sample still runs', async () => {
    store.put('אמן', 'מוכר', 'שורה', SOURCE_EMBEDDED);
    store.setJson('calibration_since', 99);
    const reader = new FakeReader(clock, { [searchUrl('מוכר')]: okSearch('מוכר', 'אמן'), [LYRICS_URL]: okLyrics('שורה') });
    make(reader, { calibrationEvery: 1 }).start();
    for (let i = 0; i < 200; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reader.calls.length, 0); // closed browser: no sampling
    enqueueCalibration(store, 1, '2026-10-07T12:00:00+00:00', 90);
    worker!.wake();
    await until(() => reader.calls.length === 2, 'on-demand sample fetched');
  });
  test('a CAPTCHA wait that gives up early still waits out the cooldown', async () => {
    enqueue('שיר');
    const reader = new FakeReader(clock, {
      [searchUrl('שיר')]: [{ outcome: 'challenge', detail: 'perfdrive' }, okSearch('שיר', 'להקה')],
      [LYRICS_URL]: okLyrics('שורה'),
    });
    reader.giveUpAtOnce = true;
    make(reader).start();
    await until(() => store.count() === 1, 'song stored after the cooldown');
    assert.ok(reader.calls[1].at - reader.calls[0].at >= 1800_000, String(reader.calls[1].at - reader.calls[0].at));
  });
  test('a read that throws counts as an error and does not block the queue', async () => {
    enqueue('שבור', 'interactive');
    enqueue('שיר');
    const reader = new FakeReader(clock, { [searchUrl('שיר')]: okSearch('שיר', 'להקה'), [LYRICS_URL]: okLyrics('שורה') });
    reader.throwing.add(searchUrl('שבור'));
    make(reader).start();
    await until(() => store.count() === 1, 'the other song stored');
    await until(() => queue.find(store, [{ artist: 'להקה', title: 'שבור' }])?.status === 'failed', 'the broken song failed after 5 attempts');
    assert.equal(queue.find(store, [{ artist: 'להקה', title: 'שבור' }])?.attempts, 5);
  });
  test('a restart during a cooldown keeps waiting until the cooldown ends', async () => {
    const state = { ...initialState(DEFAULT_LIMITS), cooldownUntil: START / 1000 + 1800 };
    store.setJson('pace', state);
    enqueue('שיר');
    const reader = new FakeReader(clock, { [searchUrl('שיר')]: okSearch('שיר', 'להקה'), [LYRICS_URL]: okLyrics('שורה') });
    make(reader).start();
    await until(() => reader.calls.length >= 1, 'first request');
    assert.ok(reader.calls[0].at >= START + 1800_000, String(reader.calls[0].at - START));
  });
  test('a restart keeps the gap after the last logged request', async () => {
    queue.logRequest(store, { at: START / 1000 - 1, kind: 'search', outcome: 'ok', httpStatus: null, detail: null, url: 'u', artist: 'a', title: 't' });
    enqueue('שיר');
    const reader = new FakeReader(clock, { [searchUrl('שיר')]: okSearch('שיר', 'להקה'), [LYRICS_URL]: okLyrics('שורה') });
    make(reader).start();
    await until(() => reader.calls.length >= 1, 'first request');
    assert.ok(reader.calls[0].at >= START - 1000 + 5000, String(reader.calls[0].at - START));
  });
  test('a CAPTCHA page that the browser reports as ok is still a challenge', async () => {
    enqueue('שיר');
    const captchaPage: RequestResult = { outcome: 'ok', page: { url: 'https://validate.perfdrive.com/?ssa=1', title: 'Radware', challenge: false, links: [], lyrics: null } };
    const reader = new FakeReader(clock, {
      [searchUrl('שיר')]: [captchaPage, okSearch('שיר', 'להקה')],
      [LYRICS_URL]: okLyrics('שורה'),
    });
    reader.solve = true;
    make(reader).start();
    await until(() => store.count() === 1, 'song stored after the CAPTCHA');
    assert.deepEqual(notes, ['Shironet CAPTCHA']);
    assert.equal(queue.find(store, [{ artist: 'להקה', title: 'שיר' }])?.attempts, 1);
  });
  test('status reports the current song, pace and browser', async () => {
    enqueue('שיר');
    const reader = new FakeReader(clock, { [searchUrl('שיר')]: okSearch('שיר', 'להקה'), [LYRICS_URL]: okLyrics('שורה') });
    reader.hold = { url: LYRICS_URL, release: () => {} };
    const w = make(reader);
    w.start();
    await until(() => reader.calls.length === 2, 'lyrics page requested');
    const status = w.status();
    assert.equal(status.running, true);
    assert.deepEqual(status.current, { artist: 'להקה', title: 'שיר', purpose: 'fetch' });
    assert.equal(status.pace.interval, 10);
    assert.deepEqual(status.browser, { open: true });
  });
});
