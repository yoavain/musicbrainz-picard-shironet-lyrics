// release.json: written by the deploy script next to package.json (commit hash and time).
// A working tree has none; /health then answers commit null.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RELEASE_FILE = 'release.json';

export interface Release {
  commit: string | null;
  time: string | null;
}

/** The release facts from <dir>/release.json; a broken file throws (a half-written deploy). */
export function readRelease(dir: string): Release {
  const path = join(dir, RELEASE_FILE);
  if (!existsSync(path)) return { commit: null, time: null };
  let value: { commit?: unknown; time?: unknown };
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof value?.commit !== 'string' || typeof value.time !== 'string') {
    throw new Error(`${path} needs "commit" and "time" strings`);
  }
  return { commit: value.commit, time: value.time };
}
