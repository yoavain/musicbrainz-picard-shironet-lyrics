// Opt-in: starts real Chrome (the configured chromePath) on local pages only.
// It never reaches the network. Run: npm run test:browser
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { openChromeSession } from '../src/reader.ts';
import type { BrowserSession } from '../src/reader.ts';
import { interpretLyrics, interpretSearch } from '../src/shironet.ts';
import { isAlive } from '../src/processes.ts';
import { silentLogger } from '../src/notifier.ts';
import { RECORD_FILE } from '../src/chrome.ts';

const fixture = (name: string) => pathToFileURL(join(import.meta.dirname, 'fixtures', name)).href;
const signal = new AbortController().signal;

describe('real Chrome session (incognito context)', () => {
  let dataDir: string;
  let session: BrowserSession;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-test-'));
    const { chromePath } = loadConfig({ SHIRONET_DATA_DIR: dataDir });
    session = await openChromeSession({ chromePath, dataDir, settleMs: 200 }, silentLogger);
  });
  after(async () => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('navigator.webdriver is false (no --enable-automation, no port 0)', async () => {
    await session.navigateAndExtract(fixture('entities.html'), signal);
    assert.equal(await session.evaluate('navigator.webdriver'), false);
  });
  test('search page: 10 results, the first one as in the Python tests', async () => {
    const results = interpretSearch(await session.navigateAndExtract(fixture('shironet_search.html'), signal));
    assert.equal(results.length, 10);
    assert.deepEqual(results[0], {
      title: 'שיר לשלום', artist: 'להקת הנח"ל', url: 'https://shironet.mako.co.il/artist?type=lyrics&lang=1&prfid=578&wrkid=3005',
    });
  });
  test('search page: the "next" link of the paging bar is found', async () => {
    const page = await session.navigateAndExtract(fixture('shironet_search.html'), signal);
    assert.equal(page.nextPageHref, '?q=%D7%A9%D7%99%D7%A8+%D7%9C%D7%A9%D7%9C%D7%95%D7%9D&type=lyrics&page=2');
    const lyrics = await session.navigateAndExtract(fixture('shironet_lyrics.html'), signal);
    assert.equal(lyrics.nextPageHref, null);
  });
  test('lyrics page: only <br> breaks lines; entities decoded', async () => {
    const page = interpretLyrics(await session.navigateAndExtract(fixture('shironet_lyrics.html'), signal));
    assert.deepEqual(page, {
      title: 'שיר לשלום', artist: 'להקת הנח"ל',
      lyrics: 'שורה ראשונה\nשורה שנייה "בגרשיים"\n\nבית שני, שורה ראשונה\nבית שני, שורה שנייה',
    });
  });
  test('challenge page is a challenge; content pages and the home page are not', async () => {
    assert.equal((await session.navigateAndExtract(fixture('shironet_challenge.html'), signal)).challenge, true);
    assert.equal((await session.navigateAndExtract(fixture('shironet_search.html'), signal)).challenge, false);
    assert.equal((await session.navigateAndExtract(fixture('shironet_home.html'), signal)).challenge, false);
  });
  test('entities, a non-breaking space and a direction mark', async () => {
    const page = interpretLyrics(await session.navigateAndExtract(fixture('entities.html'), signal));
    assert.deepEqual(page, {
      title: 'שיר "בדיקה"', artist: 'זמר ראשי',
      lyrics: 'אבג שורה\nשורה‏ עם סימן כיוון\nשורה עם & ו<סוגריים>',
    });
  });
  test('close leaves no process and no record (leak check)', async () => {
    const pid = session.pid;
    const report = await session.close('test end');
    assert.notEqual(report.how, 'killed');
    for (let i = 0; i < 50 && isAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(isAlive(pid), false);
    assert.equal(existsSync(join(dataDir, RECORD_FILE)), false);
  });
});

describe('nothing from a visit reaches the next session', () => {
  let dataDir: string;
  let server: Server;
  let base: string;
  let cookieSeen: string | null = null;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'isolation-test-'));
    server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      if (request.url === '/set') {
        response.setHeader('set-cookie', 'visit=1; Max-Age=86400; Path=/');
        response.end('<!doctype html><title>set</title><script>localStorage.setItem("ls", "1")</script>');
      } else {
        cookieSeen = request.headers.cookie ?? '';
        response.end('<!doctype html><title>probe</title>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('a cookie and localStorage set in one session are gone in the next', async () => {
    const { chromePath } = loadConfig({ SHIRONET_DATA_DIR: dataDir });
    const first = await openChromeSession({ chromePath, dataDir, settleMs: 300 }, silentLogger);
    await first.navigateAndExtract(`${base}/set`, signal);
    await first.navigateAndExtract(`${base}/probe`, signal);
    assert.equal(cookieSeen, 'visit=1'); // within one session the cookie is kept (Radware needs this)
    await first.close('first session done');

    const second = await openChromeSession({ chromePath, dataDir, settleMs: 300 }, silentLogger);
    try {
      cookieSeen = null;
      await second.navigateAndExtract(`${base}/probe`, signal);
      assert.equal(cookieSeen, '');
      assert.equal(await second.evaluate('localStorage.getItem("ls")'), null);
    } finally {
      await second.close('second session done');
    }
  });
});
