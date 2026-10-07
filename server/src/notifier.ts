// Notifications for things a person must see: a CAPTCHA to solve, calibration alerts.
// Windows toast through PowerShell (text in environment variables, which are UTF-16)
// and/or ntfy published as JSON (HTTP headers are not UTF-8, so no Title header).

import { spawn } from 'node:child_process';

export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const noop = () => {};
export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

export interface Notifier {
  notify(title: string, message: string): Promise<void>;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: 'ignore'; windowsHide: boolean },
) => { on(event: 'error', listener: (error: Error) => void): unknown; unref(): void };

export interface NotifierOptions {
  windows: boolean;
  ntfyUrl: string | null;
  platform?: string;
  spawnProcess?: SpawnLike;
  fetchFn?: typeof fetch;
  log?: Logger;
}

const TOAST_SCRIPT =
  'Add-Type -AssemblyName System.Windows.Forms; '
  + '$n = New-Object System.Windows.Forms.NotifyIcon; '
  + '$n.Icon = [System.Drawing.SystemIcons]::Information; '
  + '$n.BalloonTipTitle = $env:SL_TITLE; $n.BalloonTipText = $env:SL_MESSAGE; '
  + '$n.Visible = $true; $n.ShowBalloonTip(10000); Start-Sleep -Seconds 10; $n.Dispose()';

export function createNotifier(options: NotifierOptions): Notifier {
  const platform = options.platform ?? process.platform;
  const spawnProcess: SpawnLike = options.spawnProcess ?? (spawn as unknown as SpawnLike);
  const fetchFn = options.fetchFn ?? fetch;
  const log = options.log ?? silentLogger;
  const windows = options.windows && platform === 'win32';

  return {
    async notify(title: string, message: string): Promise<void> {
      if (windows) {
        try {
          const child = spawnProcess('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', TOAST_SCRIPT], {
            env: { ...process.env, SL_TITLE: title, SL_MESSAGE: message }, stdio: 'ignore', windowsHide: true,
          });
          child.on('error', (error) => log.warn({ err: error }, 'Windows notification failed'));
          child.unref();
        } catch (error) {
          log.warn({ err: error }, 'Windows notification failed');
        }
      }
      if (options.ntfyUrl) {
        try {
          const target = new URL(options.ntfyUrl);
          const topic = target.pathname.replace(/^\/+|\/+$/g, '');
          const reply = await fetchFn(`${target.origin}/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ topic, title, message }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!reply.ok) log.warn({ status: reply.status }, 'ntfy notification failed');
        } catch (error) {
          log.warn({ err: error }, 'ntfy notification failed');
        }
      }
    },
  };
}
