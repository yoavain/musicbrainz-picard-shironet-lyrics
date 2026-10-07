// Opt-in: starts real Chrome (the configured chromePath) on local fixture files.
// It never reaches the network. Run: npm run test:browser
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { openChromeSession } from '../src/reader.ts';
import type { BrowserSession } from '../src/reader.ts';
import { interpretLyrics, interpretSearch } from '../src/shironet.ts';
import { isAlive } from '../src/processes.ts';
import { silentLogger } from '../src/notifier.ts';
import { ChromeProcess, PROFILE_PREFIX } from '../src/chrome.ts';
import { CdpConnection } from '../src/cdp.ts';

describe('launch looks like a normal browser', () => {
  test('navigator.webdriver is false (no --enable-automation, no port 0)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'webdriver-test-'));
    const chrome = await ChromeProcess.launch({ chromePath: loadConfig({ SHIRONET_DATA_DIR: dataDir }).chromePath, dataDir }, silentLogger);
    const cdp = await CdpConnection.connect(chrome.browserWsUrl);
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
      const page = targetInfos.find((target) => target.type === 'page')!;
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      const answer = await cdp.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true }, sessionId);
      assert.equal(answer.result.value, false);
    } finally {
      await chrome.close(cdp);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

const fixture = (name: string) => pathToFileURL(join(import.meta.dirname, 'fixtures', name)).href;

describe('real Chrome session', () => {
  let dataDir: string;
  let session: BrowserSession;
  const signal = new AbortController().signal;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-test-'));
    const { chromePath } = loadConfig({ SHIRONET_DATA_DIR: dataDir });
    session = await openChromeSession({ chromePath, dataDir, settleMs: 200 }, silentLogger);
  });
  after(async () => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('search page: 10 results, the first one as in the Python tests', async () => {
    const results = interpretSearch(await session.navigateAndExtract(fixture('shironet_search.html'), signal));
    assert.equal(results.length, 10);
    assert.deepEqual(results[0], {
      title: 'שיר לשלום', artist: 'להקת הנח"ל', url: 'https://shironet.mako.co.il/artist?type=lyrics&lang=1&prfid=578&wrkid=3005',
    });
  });
  test('lyrics page: only <br> breaks lines; entities decoded', async () => {
    const page = interpretLyrics(await session.navigateAndExtract(fixture('shironet_lyrics.html'), signal));
    assert.deepEqual(page, {
      title: 'שיר לשלום', artist: 'להקת הנח"ל',
      lyrics: 'שורה ראשונה\nשורה שנייה "בגרשיים"\n\nבית שני, שורה ראשונה\nבית שני, שורה שנייה',
    });
  });
  test('challenge page is a challenge; content pages are not', async () => {
    assert.equal((await session.navigateAndExtract(fixture('shironet_challenge.html'), signal)).challenge, true);
    assert.equal((await session.navigateAndExtract(fixture('shironet_search.html'), signal)).challenge, false);
  });
  test('entities, a non-breaking space and a direction mark', async () => {
    const page = interpretLyrics(await session.navigateAndExtract(fixture('entities.html'), signal));
    assert.deepEqual(page, {
      title: 'שיר "בדיקה"', artist: 'זמר ראשי',
      lyrics: 'אבג שורה\nשורה\u200F עם סימן כיוון\nשורה עם & ו<סוגריים>',
    });
  });
  test('close leaves no process and no profile (leak check)', async () => {
    const pid = session.pid;
    const report = await session.close('test end');
    assert.equal(report.profileRemoved, true);
    for (let i = 0; i < 50 && isAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(isAlive(pid), false);
    assert.deepEqual(readdirSync(dataDir).filter((name) => name.startsWith(PROFILE_PREFIX)), []);
    assert.equal(existsSync(join(dataDir, 'browser.json')), false);
  });
});
