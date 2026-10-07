import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT, defaultChromePath, defaultDataDir, loadConfig } from '../src/config.ts';

const CHROME_DEV = 'C:\\Program Files\\Google\\Chrome Dev\\Application\\chrome.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const nothingExists = () => false;

describe('config', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'config-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function load(env: Record<string, string> = {}, platform = 'linux') {
    return loadConfig({ SHIRONET_DATA_DIR: dir, ...env }, platform, '/home/u', nothingExists);
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
    assert.deepEqual(config.browser, { idleMinutes: 10, maxAgeMinutes: 60, maxPages: 200, maxMemoryMb: 600 });
    assert.deepEqual(config.pace, { startInterval: 10, minInterval: 5 });
    assert.deepEqual(config.worker, {
      missTtlHours: 168, failedRetryHours: 24, maxAttempts: 5, calibrationEvery: 50,
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
    const config = load({ SHIRONET_HOST: 'localhost', SHIRONET_LOG_LEVEL: 'warn', SHIRONET_CHROME: 'C:\\c.exe' });
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
  test('a host that is not loopback is refused until the LAN token exists', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', '::']) {
      assert.throws(() => load({ SHIRONET_HOST: host }), /loopback/);
    }
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      assert.equal(load({ SHIRONET_HOST: host }).host, host);
    }
  });
  test('a bad port is refused', () => {
    assert.throws(() => load({ SHIRONET_PORT: '99999' }), /port/i);
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
