// Configuration: config.json in the data dir, overridden by environment variables.
// Every limit in the server is a key here. A wrong type or a bad number stops the start
// with the key's name: a silently broken limit is worse than no start.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkerOptions } from './worker.ts';

export const DEFAULT_PORT = 8735;
export const DB_FILE = 'lyrics.sqlite3';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export interface BrowserConfig {
  idleMinutes: number;
  maxAgeMinutes: number;
  maxPages: number;
  maxMemoryMb: number;
  maxMemoryGrowth: number;
}

export type WorkerConfig = Pick<WorkerOptions,
  'missTtlHours' | 'failedRetryHours' | 'maxAttempts' | 'maxSearchPages' | 'calibrationEvery' | 'calibrationGapDays'
  | 'calibrationAlertMedian' | 'requestLogDays'>;

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  allowedHosts: string[];
  logLevel: string;
  chromePath: string;
  browser: BrowserConfig;
  pace: { startInterval: number; minInterval: number };
  worker: WorkerConfig;
  notify: { windows: boolean; ntfyUrl: string | null };
}

type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;

export function defaultDataDir(env: Env, platform: string, home: string): string {
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'shironet-lyrics-server');
  }
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'shironet-lyrics-server');
}

const WINDOWS_CHROMES = [
  'C:\\Program Files\\Google\\Chrome Dev\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function defaultChromePath(platform: string, exists: (path: string) => boolean): string {
  if (platform === 'win32') return WINDOWS_CHROMES.find(exists) ?? WINDOWS_CHROMES[0];
  return 'chromium';
}

function section(file: Json, key: string): Json {
  const value = file[key];
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`config.json: ${key} must be an object`);
  return value as Json;
}

/** A number from a config section, checked against [min, max]; the default when absent. */
function num(values: Json, path: string, key: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER, integer = false): number {
  const value = values[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`config.json: ${path}.${key} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return value;
}

function bool(values: Json, path: string, key: string, fallback: boolean): boolean {
  const value = values[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`config.json: ${path}.${key} must be true or false`);
  return value;
}

function str(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`config.json: ${path} must be a string`);
  return value;
}

export function loadConfig(
  env: Env = process.env, platform: string = process.platform, home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): Config {
  const dataDir = env.SHIRONET_DATA_DIR || defaultDataDir(env, platform, home);
  const path = join(dataDir, 'config.json');
  let file: Json = {};
  if (existsSync(path)) {
    try {
      // A file saved by Notepad may start with a BOM, which JSON.parse refuses.
      file = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Json;
    } catch (error) {
      throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
    }
  }

  const host = env.SHIRONET_HOST || str(file.host, 'host') || '127.0.0.1';
  // The API has no login. A LAN bind needs the shared token from the spec, which does not
  // exist yet; until then, any client on the network could send "Host: 127.0.0.1:<port>".
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(`Host ${host} is not loopback. Binding to a network address needs the API token, which is not built yet.`);
  }
  const port = Number(env.SHIRONET_PORT || file.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  const extraHosts = file.allowedHosts ?? [];
  if (!Array.isArray(extraHosts) || !extraHosts.every((h) => typeof h === 'string')) {
    throw new Error('config.json: allowedHosts must be a list of strings');
  }
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...extraHosts].map((name) => name.toLowerCase());

  const logLevel = env.SHIRONET_LOG_LEVEL || str(file.logLevel, 'logLevel') || 'info';
  if (!LOG_LEVELS.has(logLevel)) throw new Error(`config.json: logLevel must be one of ${[...LOG_LEVELS].join(', ')}`);

  const browserFile = section(file, 'browser');
  const browser: BrowserConfig = {
    idleMinutes: num(browserFile, 'browser', 'idleMinutes', 10, 1, 24 * 60),
    maxAgeMinutes: num(browserFile, 'browser', 'maxAgeMinutes', 60, 1, 24 * 60),
    maxPages: num(browserFile, 'browser', 'maxPages', 200, 1, 100_000, true),
    maxMemoryMb: num(browserFile, 'browser', 'maxMemoryMb', 2000, 100, 64_000),
    maxMemoryGrowth: num(browserFile, 'browser', 'maxMemoryGrowth', 2, 1.2, 20),
  };

  const paceFile = section(file, 'pace');
  const minInterval = num(paceFile, 'pace', 'minInterval', 5, 1, 3600);
  const startInterval = num(paceFile, 'pace', 'startInterval', Math.max(10, minInterval), minInterval, 3600);

  const workerFile = section(file, 'worker');
  const worker: WorkerConfig = {
    missTtlHours: num(workerFile, 'worker', 'missTtlHours', 168, 1, 24 * 365),
    failedRetryHours: num(workerFile, 'worker', 'failedRetryHours', 24, 1, 24 * 365),
    maxAttempts: num(workerFile, 'worker', 'maxAttempts', 5, 1, 100, true),
    maxSearchPages: num(workerFile, 'worker', 'maxSearchPages', 5, 1, 20, true),
    calibrationEvery: num(workerFile, 'worker', 'calibrationEvery', 50, 0, 100_000, true),
    calibrationGapDays: num(workerFile, 'worker', 'calibrationGapDays', 90, 1, 3650),
    calibrationAlertMedian: num(workerFile, 'worker', 'calibrationAlertMedian', 0.8, 0, 1),
    requestLogDays: num(workerFile, 'worker', 'requestLogDays', 90, 1, 3650),
  };

  const notifyFile = section(file, 'notify');
  const notify = {
    windows: bool(notifyFile, 'notify', 'windows', platform === 'win32'),
    ntfyUrl: env.SHIRONET_NTFY_URL || str(notifyFile.ntfyUrl, 'notify.ntfyUrl') || null,
  };

  const chromePath = env.SHIRONET_CHROME || str(file.chromePath, 'chromePath') || defaultChromePath(platform, exists);
  return { host, port, dataDir, allowedHosts, logLevel, chromePath, browser, pace: { startInterval, minInterval }, worker, notify };
}
