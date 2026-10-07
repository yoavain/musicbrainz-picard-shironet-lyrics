import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ChromeReader } from '../src/reader.ts';
import type { BrowserSession, ReaderLimits } from '../src/reader.ts';
import type { ExtractedPage } from '../src/shironet.ts';
import { silentLogger } from '../src/notifier.ts';

const SHIRONET_PAGE: ExtractedPage = { url: 'https://shironet.mako.co.il/searchSongs?q=x', title: 'x', challenge: false, links: [], lyrics: null };
const CAPTCHA_PAGE: ExtractedPage = { url: 'https://validate.perfdrive.com/?ssa=1', title: 'Radware', challenge: true, links: [], lyrics: null };

class FakeSession implements BrowserSession {
  static opened: FakeSession[] = [];
  readonly pid: number;
  readonly startedAt = Date.now();
  closedWith: string | null = null;
  pages: ExtractedPage[] = [SHIRONET_PAGE];
  current: ExtractedPage = SHIRONET_PAGE;
  failNext = false;
  memory = 100;
  constructor() { this.pid = 1000 + FakeSession.opened.length; FakeSession.opened.push(this); }
  async navigateAndExtract(_url: string, signal: AbortSignal) {
    if (signal.aborted) throw new Error('aborted');
    if (this.failNext) { this.failNext = false; throw new Error('Page.navigate timed out'); }
    this.current = this.pages.length > 1 ? this.pages.shift()! : this.pages[0];
    return this.current;
  }
  async extract() { return this.current; }
  async memoryBytes() { return this.memory; }
  async close(reason: string) { this.closedWith = reason; return { how: 'clean' as const, profileRemoved: true }; }
}

const LIMITS: ReaderLimits = { idleMs: 60_000, maxAgeMs: 3_600_000, maxPages: 3, maxMemoryBytes: 1000, humanPollMs: 10, memoryCheckMs: 60_000 };

describe('ChromeReader', () => {
  let reader: ChromeReader | null = null;
  afterEach(async () => {
    await reader?.close('test end');
    FakeSession.opened = [];
  });
  function make(limits: Partial<ReaderLimits> = {}) {
    reader = new ChromeReader(async () => new FakeSession(), { ...LIMITS, ...limits }, silentLogger);
    return reader;
  }
  const signal = () => new AbortController().signal;

  test('opens a session on the first read and reuses it', async () => {
    const r = make();
    assert.equal(r.isOpen(), false);
    assert.equal((await r.read('https://shironet.mako.co.il/a', signal())).outcome, 'ok');
    await r.read('https://shironet.mako.co.il/b', signal());
    assert.equal(FakeSession.opened.length, 1);
    assert.equal(r.isOpen(), true);
  });
  test('recycles after the page limit', async () => {
    const r = make();
    for (let i = 0; i < 4; i += 1) await r.read('https://shironet.mako.co.il/p', signal());
    assert.equal(FakeSession.opened.length, 2);
    assert.match(FakeSession.opened[0].closedWith ?? '', /page limit/);
  });
  test('a failed read closes the session and answers error; the next read opens a new one', async () => {
    const r = make();
    await r.read('https://shironet.mako.co.il/a', signal());
    FakeSession.opened[0].failNext = true;
    const failed = await r.read('https://shironet.mako.co.il/b', signal());
    assert.deepEqual(failed, { outcome: 'error', detail: 'Page.navigate timed out' });
    assert.match(FakeSession.opened[0].closedWith ?? '', /error/);
    assert.equal(r.isOpen(), false);
    await r.read('https://shironet.mako.co.il/c', signal());
    assert.equal(FakeSession.opened.length, 2);
  });
  test('a read on an aborted signal rejects (the worker is stopping)', async () => {
    const r = make();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(r.read('https://shironet.mako.co.il/a', controller.signal));
  });
  test('a challenge page is reported as a challenge', async () => {
    const r = make();
    await r.read('https://shironet.mako.co.il/a', signal());
    FakeSession.opened[0].pages = [CAPTCHA_PAGE];
    const result = await r.read('https://shironet.mako.co.il/b', signal());
    assert.equal(result.outcome, 'challenge');
  });
  test('waitForHuman: true once the window shows Shironet again', async () => {
    const r = make();
    await r.read('https://shironet.mako.co.il/a', signal());
    const session = FakeSession.opened[0];
    session.current = CAPTCHA_PAGE;
    setTimeout(() => { session.current = SHIRONET_PAGE; }, 30);
    assert.equal(await r.waitForHuman(5_000, signal()), true);
  });
  test('waitForHuman: false at the timeout, and false at once without a session', async () => {
    const r = make();
    assert.equal(await r.waitForHuman(5_000, signal()), false);
    await r.read('https://shironet.mako.co.il/a', signal());
    FakeSession.opened[0].current = CAPTCHA_PAGE;
    assert.equal(await r.waitForHuman(50, signal()), false);
  });
  test('closes the session after the idle time', async () => {
    const r = make({ idleMs: 30 });
    await r.read('https://shironet.mako.co.il/a', signal());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(r.isOpen(), false);
    assert.match(FakeSession.opened[0].closedWith ?? '', /idle/);
  });
  test('recycles when memory passes the limit', async () => {
    const r = make({ memoryCheckMs: 10 });
    await r.read('https://shironet.mako.co.il/a', signal());
    FakeSession.opened[0].memory = 5000;
    await new Promise((resolve) => setTimeout(resolve, 60));
    await r.read('https://shironet.mako.co.il/b', signal());
    assert.equal(FakeSession.opened.length, 2);
    assert.match(FakeSession.opened[0].closedWith ?? '', /memory/);
  });
  test('status shows the session and the last close', async () => {
    const r = make();
    await r.read('https://shironet.mako.co.il/a', signal());
    const open = r.status();
    assert.equal(open.open, true);
    assert.equal(open.pid, 1000);
    assert.equal(open.pages, 1);
    await r.close('done');
    const closed = r.status();
    assert.equal(closed.open, false);
    assert.deepEqual(closed.lastClose, { reason: 'done', how: 'clean', profileRemoved: true });
  });
});
