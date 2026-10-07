import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT, defaultDataDir, loadConfig } from '../src/config.ts';

describe('config', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'config-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('default data dir on Windows uses LOCALAPPDATA', () => {
    assert.equal(defaultDataDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\home'), join('C:\\L', 'shironet-lyrics-server'));
  });
  test('default data dir on Linux uses XDG_STATE_HOME, else ~/.local/state', () => {
    assert.equal(defaultDataDir({ XDG_STATE_HOME: '/s' }, 'linux', '/home/u'), join('/s', 'shironet-lyrics-server'));
    assert.equal(defaultDataDir({}, 'linux', '/home/u'), join('/home/u', '.local', 'state', 'shironet-lyrics-server'));
  });
  test('defaults', () => {
    const config = loadConfig({ SHIRONET_DATA_DIR: dir }, 'linux', '/home/u');
    assert.deepEqual(config, {
      host: '127.0.0.1', port: DEFAULT_PORT, dataDir: dir,
      allowedHosts: [`127.0.0.1:${DEFAULT_PORT}`, `localhost:${DEFAULT_PORT}`],
    });
  });
  test('config file with a BOM, overridden by the environment', () => {
    writeFileSync(join(dir, 'config.json'), '\uFEFF{"port": 9000, "allowedHosts": ["Server.Lan:9000"]}', 'utf8');
    const config = loadConfig({ SHIRONET_DATA_DIR: dir, SHIRONET_HOST: 'localhost' }, 'linux', '/home/u');
    assert.equal(config.host, 'localhost');
    assert.equal(config.port, 9000);
    assert.deepEqual(config.allowedHosts, ['127.0.0.1:9000', 'localhost:9000', 'server.lan:9000']);
  });
  test('a host that is not loopback is refused until the LAN token exists', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', '::']) {
      assert.throws(() => loadConfig({ SHIRONET_DATA_DIR: dir, SHIRONET_HOST: host }, 'linux', '/home/u'), /loopback/);
    }
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      assert.equal(loadConfig({ SHIRONET_DATA_DIR: dir, SHIRONET_HOST: host }, 'linux', '/home/u').host, host);
    }
  });
  test('a bad port is refused', () => {
    assert.throws(() => loadConfig({ SHIRONET_DATA_DIR: dir, SHIRONET_PORT: '99999' }, 'linux', '/home/u'), /port/i);
  });
});
