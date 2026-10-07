// The PageReader for the worker: one Chrome session at a time, opened on demand, closed
// when idle, recycled on age, page count or memory. A failed read closes the session (its
// processes and profile go with it) and the next read starts a fresh one.

import { CdpConnection } from './cdp.ts';
import { ChromeProcess, recoverLeftovers } from './chrome.ts';
import type { CloseReport } from './chrome.ts';
import { EXTRACT_SOURCE } from './extract.ts';
import type { RequestResult } from './fetcher.ts';
import type { Logger } from './notifier.ts';
import { treeMemory } from './processes.ts';
import { HOST, isChallengeUrl } from './shironet.ts';
import type { ExtractedPage } from './shironet.ts';
import type { Clock, PageReader } from './worker.ts';
import { realClock } from './worker.ts';

export interface BrowserSession {
  readonly pid: number;
  readonly startedAt: number;
  navigateAndExtract(url: string, signal: AbortSignal): Promise<ExtractedPage>;
  extract(): Promise<ExtractedPage>;
  /** Evaluates an expression in the session's page (returned by value). */
  evaluate(expression: string): Promise<unknown>;
  memoryBytes(): Promise<number | null>;
  close(reason: string): Promise<CloseReport>;
}

export interface SessionOptions {
  chromePath: string;
  dataDir: string;
  settleMs?: number;
  navTimeoutMs?: number;
}

const delay = (ms: number, signal: AbortSignal) => realClock.sleep(ms, signal);

/**
 * A real Chrome session: launch Chrome on its fixed folder, then browse in a fresh
 * incognito context (Target.createBrowserContext). Cookies, storage and cache of the visit
 * live in memory and are gone when the context closes; nothing reaches the folder, so the
 * server never has Chrome files to delete (measured 2026-10-07: modes compared locally).
 */
export async function openChromeSession(options: SessionOptions, log: Logger): Promise<BrowserSession> {
  await recoverLeftovers(options.dataDir, log);
  const chrome = await ChromeProcess.launch({ chromePath: options.chromePath, dataDir: options.dataDir }, log);
  let cdp: CdpConnection | null = null;
  try {
    cdp = await CdpConnection.connect(chrome.browserWsUrl);
    const connection = cdp;
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets', {}, undefined, 10_000);
    const startPages = targetInfos.filter((target) => target.type === 'page');
    const { browserContextId } = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true }, undefined, 10_000);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId }, undefined, 10_000);
    // The start window of the regular profile is not used; close it so only the incognito window shows.
    for (const page of startPages) {
      await cdp.send('Target.closeTarget', { targetId: page.targetId }, undefined, 10_000).catch(() => {});
    }
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }, undefined, 10_000);
    await cdp.send('Page.enable', {}, sessionId, 10_000);
    const settleMs = options.settleMs ?? 3_000;
    const navTimeoutMs = options.navTimeoutMs ?? 45_000;

    const evaluate = async (expression: string): Promise<unknown> => {
      const answer = await connection.send<{ result: { value: unknown }; exceptionDetails?: { text: string } }>(
        'Runtime.evaluate', { expression, returnByValue: true }, sessionId, 15_000,
      );
      if (answer.exceptionDetails) throw new Error(`page script failed: ${answer.exceptionDetails.text}`);
      return answer.result.value;
    };
    const extract = async (): Promise<ExtractedPage> => (await evaluate(EXTRACT_SOURCE)) as ExtractedPage;

    return {
      pid: chrome.pid,
      startedAt: chrome.startedAt,
      async navigateAndExtract(url: string, signal: AbortSignal): Promise<ExtractedPage> {
        const loaded = connection.waitForEvent('Page.loadEventFired', sessionId, navTimeoutMs, signal);
        loaded.catch(() => {}); // handled below; avoids an unhandled rejection when navigate fails first
        const navigation = await connection.send<{ errorText?: string }>('Page.navigate', { url }, sessionId, navTimeoutMs);
        if (navigation.errorText) throw new Error(`navigation failed: ${navigation.errorText}`);
        await loaded;
        await delay(settleMs, signal); // let the bot-check script run
        if (signal.aborted) throw new Error('aborted');
        return extract();
      },
      extract,
      evaluate,
      memoryBytes: () => treeMemory(chrome.pid),
      close: async (reason: string) => {
        log.info({ browserPid: chrome.pid, reason }, 'closing browser');
        await connection.send('Target.disposeBrowserContext', { browserContextId }, undefined, 5_000).catch(() => {});
        return chrome.close(connection);
      },
    };
  } catch (error) {
    await chrome.close(cdp);
    throw error;
  }
}

export interface ReaderLimits {
  idleMs: number;
  maxAgeMs: number;
  maxPages: number;
  /** Hard ceiling for the browser's private memory. */
  maxMemoryBytes: number;
  /** Recycle when memory reaches this many times the session's first reading. */
  maxMemoryGrowth: number;
  humanPollMs: number;
  memoryCheckMs: number;
}

function isShironetPage(page: ExtractedPage): boolean {
  try {
    const host = new URL(page.url).hostname;
    return !page.challenge && !isChallengeUrl(page.url) && (host === HOST || host.endsWith(`.${HOST}`));
  } catch {
    return false;
  }
}

export class ChromeReader implements PageReader {
  private readonly open: () => Promise<BrowserSession>;
  private readonly limits: ReaderLimits;
  private readonly log: Logger;
  private readonly clock: Clock;
  private session: BrowserSession | null = null;
  private pages = 0;
  private recycleReason: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private lastMemory: number | null = null;
  private memoryBaseline: number | null = null;
  private lastClose: { reason: string; how: string } | null = null;
  private closing: Promise<void> | null = null;

  constructor(open: () => Promise<BrowserSession>, limits: ReaderLimits, log: Logger, clock: Clock = realClock) {
    this.open = open;
    this.limits = limits;
    this.log = log;
    this.clock = clock;
  }

  async read(url: string, signal: AbortSignal): Promise<RequestResult> {
    if (signal.aborted) throw new Error('aborted');
    this.clearIdle();
    try {
      await this.closing;
      const reason = this.session ? this.recycleDue() : null;
      if (reason) await this.closeSession(reason);
      if (!this.session) await this.openSession();
      const page = await this.session!.navigateAndExtract(url, signal);
      this.pages += 1;
      if (page.challenge || isChallengeUrl(page.url)) return { outcome: 'challenge', detail: `challenge page ${page.url}` };
      return { outcome: 'ok', page };
    } catch (error) {
      if (signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      await this.closeSession(`error: ${detail}`);
      return { outcome: 'error', detail };
    } finally {
      this.armIdle();
    }
  }

  async waitForHuman(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    this.clearIdle(); // the window must stay open while a person solves the CAPTCHA
    try {
      const deadline = this.clock.now() + timeoutMs;
      while (!signal.aborted && this.session) {
        const left = deadline - this.clock.now();
        if (left <= 0) return false;
        await this.clock.sleep(Math.min(this.limits.humanPollMs, left), signal);
        if (signal.aborted || !this.session) return false;
        try {
          if (isShironetPage(await this.session.extract())) return true;
        } catch {
          return false; // the window or the browser is gone
        }
      }
      return false;
    } finally {
      this.armIdle();
    }
  }

  isOpen(): boolean {
    return this.session !== null;
  }

  async close(reason: string): Promise<void> {
    this.clearIdle();
    await this.closeSession(reason);
  }

  status(): Record<string, unknown> {
    const session = this.session;
    return {
      open: session !== null,
      pid: session?.pid ?? null,
      ageSeconds: session ? Math.round((this.clock.now() - session.startedAt) / 1000) : null,
      pages: session ? this.pages : null,
      memoryMb: this.lastMemory === null ? null : Math.round(this.lastMemory / 1024 / 1024),
      lastClose: this.lastClose,
    };
  }

  private recycleDue(): string | null {
    if (this.recycleReason) return this.recycleReason;
    if (this.pages >= this.limits.maxPages) return `page limit (${this.limits.maxPages})`;
    if (this.session && this.clock.now() - this.session.startedAt >= this.limits.maxAgeMs) return 'age limit';
    return null;
  }

  private async openSession(): Promise<void> {
    this.session = await this.open();
    this.pages = 0;
    this.recycleReason = null;
    this.lastMemory = null;
    this.memoryBaseline = null;
    this.memoryTimer = setInterval(() => { void this.checkMemory(); }, this.limits.memoryCheckMs);
    this.memoryTimer.unref?.();
  }

  private async checkMemory(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      const memory = await session.memoryBytes();
      this.lastMemory = memory;
      if (memory === null) return;
      // A fresh browser's size depends on the machine; growth against the session's own
      // first reading is what shows a leak. The ceiling is a backstop.
      this.memoryBaseline ??= memory;
      const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
      if (memory > this.limits.maxMemoryBytes) {
        this.recycleReason = `memory limit (${mb(memory)} MB)`;
      } else if (memory >= this.memoryBaseline * this.limits.maxMemoryGrowth) {
        this.recycleReason = `memory growth (${mb(memory)} MB, started at ${mb(this.memoryBaseline)} MB)`;
      }
    } catch (error) {
      this.log.warn({ err: error }, 'cannot read browser memory');
    }
  }

  private async closeSession(reason: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    this.memoryTimer = null;
    this.closing = (async () => {
      try {
        const report = await session.close(reason);
        this.lastClose = { reason, how: report.how };
      } catch (error) {
        this.log.error({ err: error }, 'browser close failed');
        this.lastClose = { reason, how: 'failed' };
      }
    })();
    await this.closing;
    this.closing = null;
  }

  private armIdle(): void {
    this.clearIdle();
    if (!this.session) return;
    this.idleTimer = setTimeout(() => { void this.closeSession('idle'); }, this.limits.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
