import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT, defaultChromePath, defaultDataDir, loadConfig, localBaseUrl } from '../src/config.ts';

const CHROME_DEV = 'C:\\Program Files\\Google\\Chrome Dev\\Application\\chrome.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const nothingExists = () => false;
const TOKEN = 'a'.repeat(16) + 'B0-_.~+/=';

describe('config', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'config-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function load(env: Record<string, string> = {}, platform = 'linux') {
    return loadConfig({ LYRICS_SERVER_DATA_DIR: dir, ...env }, platform, '/home/u', nothingExists);
  }
  function writeConfig(value: unknown) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(value), 'utf8');
  }

  test('default data dir on Windows uses LOCALAPPDATA', () => {
    assert.equal(defaultDataDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\home'), join('C:\\L', 'shironet-lyrics-server'));
  });
  test('default data dir on Linux uses XDG_STATE_HOME, else ~/.local/state', () => {
    assert.equal(defaultDataDir({ XDG_STATE_HOME: '/s' }, 'linux', '/home/u'), join('/s', 'shironet-lyrics-server'));
    assert.equal(defaultDataDir({}, 'linux', '/home/u'), join('/home/u', '.local', 'state', 'shironet-lyrics-server'));
  });
  test('default Chrome: Chrome Dev, then Chrome, on Windows; chromium on Linux', () => {
    assert.equal(defaultChromePath('win32', (p) => p === CHROME_DEV || p === CHROME), CHROME_DEV);
    assert.equal(defaultChromePath('win32', (p) => p === CHROME), CHROME);
    assert.equal(defaultChromePath('linux', nothingExists), 'chromium');
  });
  test('defaults', () => {
    const config = load();
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, DEFAULT_PORT);
    assert.equal(config.dataDir, dir);
    assert.deepEqual(config.allowedHosts, [`127.0.0.1:${DEFAULT_PORT}`, `localhost:${DEFAULT_PORT}`]);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.chromePath, 'chromium');
    assert.deepEqual(config.browser, { idleMinutes: 10, maxAgeMinutes: 60, maxPages: 200, maxMemoryMb: 2000, maxMemoryGrowth: 2, extraArgs: [] });
    assert.equal(config.apiToken, null);
    assert.deepEqual(config.pace, { startInterval: 10, minInterval: 5 });
    assert.deepEqual(config.worker, {
      missTtlHours: 168, failedRetryHours: 24, maxAttempts: 5, maxSearchPages: 5, maxWorksPages: 40, artistRefreshDays: 30,
      calibrationEvery: 50,
      calibrationGapDays: 90, calibrationAlertMedian: 0.8, requestLogDays: 90,
    });
    assert.deepEqual(config.notify, { windows: false, ntfyUrl: null });
    assert.equal(load({}, 'win32').notify.windows, true);
  });
  test('config file with a BOM, nested values, overridden by the environment', () => {
    writeFileSync(join(dir, 'config.json'), '\uFEFF' + JSON.stringify({
      port: 9000, allowedHosts: ['Server.Lan:9000'], browser: { maxPages: 50 }, pace: { minInterval: 8 },
      worker: { calibrationEvery: 0 }, notify: { ntfyUrl: 'https://ntfy.example/x' }, logLevel: 'debug',
    }), 'utf8');
    const config = load({ LYRICS_SERVER_HOST: 'localhost', LYRICS_SERVER_LOG_LEVEL: 'warn', LYRICS_SERVER_CHROME: 'C:\\c.exe' });
    assert.equal(config.host, 'localhost');
    assert.equal(config.port, 9000);
    assert.deepEqual(config.allowedHosts, ['127.0.0.1:9000', 'localhost:9000', 'server.lan:9000']);
    assert.equal(config.browser.maxPages, 50);
    assert.equal(config.browser.idleMinutes, 10);
    assert.equal(config.pace.minInterval, 8);
    assert.equal(config.worker.calibrationEvery, 0);
    assert.equal(config.notify.ntfyUrl, 'https://ntfy.example/x');
    assert.equal(config.logLevel, 'warn');
    assert.equal(config.chromePath, 'C:\\c.exe');
  });
  test('a host that is not loopback needs the API token', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', '::']) {
      assert.throws(() => load({ LYRICS_SERVER_HOST: host }), /LYRICS_SERVER_TOKEN/);
      assert.equal(load({ LYRICS_SERVER_HOST: host, LYRICS_SERVER_TOKEN: TOKEN }).host, host);
    }
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      assert.equal(load({ LYRICS_SERVER_HOST: host }).host, host);
    }
  });
  test('the API token comes from the environment only, and must be long', () => {
    assert.equal(load().apiToken, null);
    assert.equal(load({ LYRICS_SERVER_TOKEN: TOKEN }).apiToken, TOKEN);
    for (const bad of ['short', 'x'.repeat(23), `${TOKEN} space`, `${TOKEN}א`]) {
      assert.throws(() => load({ LYRICS_SERVER_TOKEN: bad }), /LYRICS_SERVER_TOKEN/);
    }
    writeConfig({ apiToken: TOKEN });
    assert.throws(() => load(), /LYRICS_SERVER_TOKEN/);
  });
  test('browser.extraArgs: Chrome flags added to the launch', () => {
    assert.deepEqual(load().browser.extraArgs, []);
    writeConfig({ browser: { extraArgs: ['--no-sandbox', '--lang=he'] } });
    assert.deepEqual(load().browser.extraArgs, ['--no-sandbox', '--lang=he']);
    for (const bad of ['--no-sandbox', ['no-sandbox'], [3], ['--user-data-dir=/x'], ['--remote-debugging-port=9222'],
      ['--remote-debugging-pipe'], ['--headless'], ['--headless=new']]) {
      writeConfig({ browser: { extraArgs: bad } });
      assert.throws(() => load(), /browser.extraArgs/);
    }
  });
  test('a bad port is refused', () => {
    assert.throws(() => load({ LYRICS_SERVER_PORT: '99999' }), /port/i);
  });
  test('wrong types and bad numbers are refused with the key name', () => {
    writeConfig({ browser: { maxPages: '200' } });
    assert.throws(() => load(), /browser\.maxPages/);
    writeConfig({ browser: { idleMinutes: -1 } });
    assert.throws(() => load(), /browser\.idleMinutes/);
    writeConfig({ worker: { calibrationAlertMedian: 2 } });
    assert.throws(() => load(), /worker\.calibrationAlertMedian/);
    writeConfig({ pace: { startInterval: 2, minInterval: 5 } });
    assert.throws(() => load(), /pace\.startInterval/);
    writeConfig({ notify: { windows: 'yes' } });
    assert.throws(() => load(), /notify\.windows/);
    writeConfig({ logLevel: 'loud' });
    assert.throws(() => load(), /logLevel/);
  });
  test('broken JSON names the file', () => {
    writeFileSync(join(dir, 'config.json'), '{ broken', 'utf8');
    assert.throws(() => load(), /config\.json/);
  });
});

describe('localBaseUrl', () => {
  test('a wildcard bind is called on loopback; a fixed address on itself', () => {
    assert.equal(localBaseUrl({ host: '0.0.0.0', port: 8735 }), 'http://127.0.0.1:8735');
    assert.equal(localBaseUrl({ host: '::', port: 8735 }), 'http://127.0.0.1:8735');
    assert.equal(localBaseUrl({ host: '127.0.0.1', port: 9000 }), 'http://127.0.0.1:9000');
    assert.equal(localBaseUrl({ host: 'localhost', port: 8735 }), 'http://127.0.0.1:8735');
    assert.equal(localBaseUrl({ host: '::1', port: 8735 }), 'http://[::1]:8735');
    assert.equal(localBaseUrl({ host: '192.168.68.194', port: 8735 }), 'http://192.168.68.194:8735');
  });
});
