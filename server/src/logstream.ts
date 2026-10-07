// The log file: every line also goes to stdout (a service manager collects stdout).
// Rotation closes the file before renaming it, because Windows cannot rename an open file.

import { closeSync, existsSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';

export interface LogStream {
  write(line: string): void;
  close(): void;
}

export function createLogStream(
  path: string,
  options: { maxBytes?: number; files?: number; echo?: { write(text: string): unknown } } = {},
): LogStream {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const files = Math.max(1, options.files ?? 5);
  const echo = options.echo ?? process.stdout;
  let fd = openSync(path, 'a');
  let size = statSync(path).size;

  function rotate(): void {
    closeSync(fd);
    for (let index = files - 1; index >= 1; index -= 1) {
      const older = `${path}.${index}`;
      const newer = index === 1 ? path : `${path}.${index - 1}`;
      if (existsSync(newer)) {
        rmSync(older, { force: true });
        renameSync(newer, older);
      }
    }
    if (files === 1) rmSync(path, { force: true });
    fd = openSync(path, 'a');
    size = 0;
  }

  return {
    write(line: string): void {
      echo.write(line);
      const bytes = Buffer.byteLength(line, 'utf8');
      if (size > 0 && size + bytes > maxBytes) rotate();
      writeSync(fd, line);
      size += bytes;
    },
    close(): void {
      closeSync(fd);
    },
  };
}
