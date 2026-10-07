// Configuration: config.json in the data dir, overridden by environment variables.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 8735;
export const DB_FILE = 'lyrics.sqlite3';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  allowedHosts: string[];
}

interface ConfigFile {
  host?: string;
  port?: number;
  allowedHosts?: string[];
}

type Env = Record<string, string | undefined>;

export function defaultDataDir(env: Env, platform: string, home: string): string {
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'shironet-lyrics-server');
  }
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'shironet-lyrics-server');
}

export function loadConfig(env: Env = process.env, platform: string = process.platform, home: string = homedir()): Config {
  const dataDir = env.SHIRONET_DATA_DIR || defaultDataDir(env, platform, home);
  const path = join(dataDir, 'config.json');
  // A file saved by Notepad may start with a BOM, which JSON.parse refuses.
  const file: ConfigFile = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : {};
  const host = env.SHIRONET_HOST || file.host || '127.0.0.1';
  // The API has no login. A LAN bind needs the shared token from the spec, which does not
  // exist yet; until then, any client on the network could send "Host: 127.0.0.1:<port>".
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(`Host ${host} is not loopback. Binding to a network address needs the API token, which is not built yet.`);
  }
  const port = Number(env.SHIRONET_PORT || file.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...(file.allowedHosts ?? [])]
    .map((name) => name.toLowerCase());
  return { host, port, dataDir, allowedHosts };
}
