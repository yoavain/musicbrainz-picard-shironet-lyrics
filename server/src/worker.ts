// The worker loop. It keeps no position of its own: each pass asks the database for
// the next due song, so a new server instance continues where the old one stopped.
// "Fetching" lives in memory only (inFlight); rows stay pending until an outcome.

import type { Store } from './store.ts';
import { isoTime } from './store.ts';
import * as queue from './queue.ts';
import type { QueueRow } from './queue.ts';
import { DEFAULT_RULES, processSong } from './fetcher.ts';
import type { FetchRules, RequestKind, RequestResult, SongOutcome } from './fetcher.ts';
import { isChallengeUrl } from './shironet.ts';
import type { Pacer } from './pacer.ts';
import { savePace } from './pacer.ts';
import type { Logger, Notifier } from './notifier.ts';
import {
  ALERTED_KEY, alertReason, calibrationReport, countFetch, enqueueSample, fetchesSinceSample, pickSample, resetCounter,
} from './calibration.ts';
import type { CalibrationReport } from './calibration.ts';

/**
 * The browser, as the worker sees it. read() rejects only when the signal aborts; any
 * other failure is an { outcome: 'error' } result (the worker also turns a stray rejection
 * into one). waitForHuman() may return false before timeoutMs (window closed, browser
 * gone); the worker still waits out the cooldown.
 */
export interface PageReader {
  read(url: string, signal: AbortSignal): Promise<RequestResult>;
  /** Waits up to timeoutMs for a person to solve the CAPTCHA; true when Shironet shows content again. */
  waitForHuman(timeoutMs: number, signal: AbortSignal): Promise<boolean>;
  isOpen(): boolean;
  close(reason: string): Promise<void>;
  status(): Record<string, unknown>;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  }),
};

export interface WorkerOptions extends FetchRules {
  idleCheckMs: number;
  calibrationEvery: number;
  calibrationGapDays: number;
  calibrationAlertMedian: number;
  requestLogDays: number;
}

export const DEFAULT_WORKER_OPTIONS: WorkerOptions = {
  ...DEFAULT_RULES,
  idleCheckMs: 60_000,
  calibrationEvery: 50,
  calibrationGapDays: 90,
  calibrationAlertMedian: 0.8,
  requestLogDays: 90,
};

export interface WorkerStatus {
  running: boolean;
  current: { artist: string; title: string; purpose: string } | null;
  pace: { interval: number; floor: number; cooldown: number; streak: number; challenged: boolean; challenges: Array<{ at: number; interval: number }> };
  lastChallengeAt: number | null;
  fetchesSinceSample: number;
  calibration: CalibrationReport;
  browser: Record<string, unknown>;
  recentRequests: ReturnType<typeof queue.recentRequests>;
}

/** Thrown inside the loop when the worker stops; it unwinds a song without marking it. */
class StopSignal extends Error {}

const DAY_MS = 86_400_000;

export class Worker {
  private readonly store: Store;
  private readonly reader: PageReader;
  private readonly pacer: Pacer;
  private readonly notifier: Notifier;
  private readonly log: Logger;
  private readonly options: WorkerOptions;
  private readonly clock: Clock;
  private readonly stopController = new AbortController();
  private wakeController = new AbortController();
  private loopDone: Promise<void> | null = null;
  private current: QueueRow | null = null;
  private lastRequestAt: number | null = null;
  private lastChallengeAt: number | null = null;
  private lastPruneAt = Number.NEGATIVE_INFINITY;

  constructor(deps: {
    store: Store; reader: PageReader; pacer: Pacer; notifier: Notifier; log: Logger;
    options?: Partial<WorkerOptions>; clock?: Clock;
  }) {
    this.store = deps.store;
    this.reader = deps.reader;
    this.pacer = deps.pacer;
    this.notifier = deps.notifier;
    this.log = deps.log;
    this.options = { ...DEFAULT_WORKER_OPTIONS, ...deps.options };
    this.clock = deps.clock ?? realClock;
    // A restart keeps the gap after the last request the previous instance sent.
    const last = queue.recentRequests(this.store, 1)[0];
    this.lastRequestAt = last ? last.at * 1000 : null;
  }

  start(): void {
    if (!this.loopDone) this.loopDone = this.loop();
  }

  /** Stops after the current await; the song in flight stays pending. Closes the browser. */
  async stop(): Promise<void> {
    this.stopController.abort();
    this.wakeController.abort();
    await this.loopDone;
    await this.reader.close('server stopping');
  }

  /** Ends an idle wait at once (a song was queued). */
  wake(): void {
    this.wakeController.abort();
  }

  inFlight(): { artistKey: string; titleKey: string } | null {
    return this.current && { artistKey: this.current.artistKey, titleKey: this.current.titleKey };
  }

  status(): WorkerStatus {
    const { interval, cooldown, streak, challenged, challenges } = this.pacer.state;
    return {
      running: this.loopDone !== null && !this.stopping,
      current: this.current && { artist: this.current.artist, title: this.current.title, purpose: this.current.purpose },
      pace: { interval, floor: this.pacer.effectiveFloor(this.clock.now() / 1000), cooldown, streak, challenged, challenges },
      lastChallengeAt: this.lastChallengeAt,
      fetchesSinceSample: fetchesSinceSample(this.store),
      calibration: calibrationReport(this.store),
      browser: this.reader.status(),
      recentRequests: queue.recentRequests(this.store, 20),
    };
  }

  private get stopping(): boolean {
    return this.stopController.signal.aborted;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        this.pruneRequestLog();
        const row = queue.nextDue(this.store, isoTime(new Date(this.clock.now()))) ?? this.calibrationRow();
        if (!row) {
          await this.idle();
          continue;
        }
        await this.handle(row);
      } catch (error) {
        if (this.stopping || error instanceof StopSignal) break;
        this.log.error({ err: error }, 'worker error');
        await this.clock.sleep(this.options.idleCheckMs, this.stopController.signal);
      }
    }
  }

  private async idle(): Promise<void> {
    this.wakeController = new AbortController();
    const either = AbortSignal.any([this.stopController.signal, this.wakeController.signal]);
    await this.clock.sleep(this.options.idleCheckMs, either);
  }

  /** A pending calibration row, or a new sample when it is time and the browser is already open. */
  private calibrationRow(): QueueRow | undefined {
    const pending = queue.nextCalibration(this.store);
    if (pending) return pending;
    const { calibrationEvery, calibrationGapDays } = this.options;
    if (calibrationEvery <= 0 || fetchesSinceSample(this.store) < calibrationEvery || !this.reader.isOpen()) return undefined;
    const now = isoTime(new Date(this.clock.now()));
    const sample = pickSample(this.store, now, calibrationGapDays);
    resetCounter(this.store);
    if (!sample) return undefined;
    enqueueSample(this.store, sample, now);
    return queue.nextCalibration(this.store);
  }

  private async handle(row: QueueRow): Promise<void> {
    this.current = row;
    try {
      let outcome: SongOutcome;
      try {
        outcome = await processSong(
          this.store, row, (kind, url) => this.request(kind, url, row), this.options, () => new Date(this.clock.now()),
        );
      } catch (error) {
        if (error instanceof StopSignal || this.stopping) throw error;
        outcome = this.failSong(row, error);
      }
      savePace(this.store, this.pacer.state);
      this.log.info({ artist: row.artist, title: row.title, purpose: row.purpose, outcome }, 'song finished');
      if (outcome === 'done' || outcome === 'not_found') {
        if (row.purpose === 'fetch') countFetch(this.store);
        else await this.checkCalibrationAlert();
      } else if (outcome === 'error') {
        await this.clock.sleep(this.pacer.onError() * 1000, this.stopController.signal);
      } else {
        await this.onChallenge();
      }
    } finally {
      this.current = null;
    }
  }

  /** An unexpected error inside one song: one attempt, so the 5-attempt rule applies and the queue moves on. */
  private failSong(row: QueueRow, error: unknown): SongOutcome {
    const detail = error instanceof Error ? error.message : String(error);
    this.log.error({ err: error, artist: row.artist, title: row.title }, 'song failed with an exception');
    const fresh = queue.find(this.store, [row]) ?? row;
    const now = this.clock.now();
    const failedRetry = fresh.attempts + 1 >= this.options.maxAttempts
      ? isoTime(new Date(now + this.options.failedRetryHours * 3600_000)) : null;
    queue.markError(this.store, fresh, detail, failedRetry, isoTime(new Date(now)));
    return 'error';
  }

  /** One request: waits out a cooldown and the pace, reads the page, logs it, updates the pace. */
  private async request(kind: RequestKind, url: string, row: QueueRow): Promise<RequestResult> {
    const until = this.pacer.state.cooldownUntil;
    if (until !== null && this.clock.now() < until * 1000) {
      await this.clock.sleep(until * 1000 - this.clock.now(), this.stopController.signal);
    }
    if (this.stopping) throw new StopSignal();
    if (this.lastRequestAt !== null) {
      const now = this.clock.now();
      const waitMs = this.lastRequestAt + this.pacer.nextWait(now / 1000) * 1000 - now;
      if (waitMs > 0) await this.clock.sleep(waitMs, this.stopController.signal);
    }
    if (this.stopping) throw new StopSignal();
    let result: RequestResult;
    try {
      result = await this.reader.read(url, this.stopController.signal);
    } catch (error) {
      if (this.stopping) throw new StopSignal();
      result = { outcome: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
    if (this.stopping) throw new StopSignal(); // an aborted read says nothing about the song
    // A CAPTCHA page must never count as "no results" or "no lyrics".
    if (result.outcome === 'ok' && (result.page.challenge || isChallengeUrl(result.page.url))) {
      result = { outcome: 'challenge', detail: `challenge page ${result.page.url}` };
    }
    const at = this.clock.now();
    this.lastRequestAt = at;
    queue.logRequest(this.store, {
      at: at / 1000, kind, outcome: result.outcome, httpStatus: null,
      detail: result.outcome === 'ok' ? null : result.detail, url, artist: row.artist, title: row.title,
    });
    this.log.info({ kind, outcome: result.outcome, url, artist: row.artist, title: row.title, interval: this.pacer.state.interval }, 'shironet request');
    if (result.outcome === 'ok') this.pacer.onSuccess(at / 1000);
    savePace(this.store, this.pacer.state);
    return result;
  }

  private async onChallenge(): Promise<void> {
    const now = this.clock.now();
    const waitSeconds = this.pacer.onChallenge(now / 1000);
    savePace(this.store, this.pacer.state);
    this.lastChallengeAt = now / 1000;
    const minutes = Math.round(waitSeconds / 60);
    this.log.warn({ waitSeconds, interval: this.pacer.state.interval }, 'CAPTCHA');
    await this.notifier.notify(
      'Shironet CAPTCHA',
      `Shironet shows a CAPTCHA in the server's browser window. Solve it there within ${minutes} min; otherwise the server waits ${minutes} min.`,
    );
    const solved = await this.reader.waitForHuman(waitSeconds * 1000, this.stopController.signal);
    if (this.stopping) return;
    if (solved) {
      this.pacer.clearCooldown();
      savePace(this.store, this.pacer.state);
      this.log.info({}, 'CAPTCHA solved');
      return;
    }
    // Not solved, or the wait ended early: the next request waits until cooldownUntil.
    await this.reader.close('CAPTCHA not solved');
  }

  private async checkCalibrationAlert(): Promise<void> {
    const reason = alertReason(this.store, this.options.calibrationAlertMedian);
    const alerted = this.store.getMeta(ALERTED_KEY) === '1';
    if (reason && !alerted) {
      this.store.setMeta(ALERTED_KEY, '1');
      this.log.warn({ reason }, 'calibration alert');
      await this.notifier.notify('Shironet pages may have changed', `Calibration: ${reason}.`);
    } else if (!reason && alerted) {
      this.store.setMeta(ALERTED_KEY, '0');
    }
  }

  private pruneRequestLog(): void {
    const now = this.clock.now();
    if (now - this.lastPruneAt < DAY_MS) return;
    this.lastPruneAt = now;
    const removed = queue.pruneRequests(this.store, (now - this.options.requestLogDays * DAY_MS) / 1000);
    if (removed > 0) this.log.info({ removed }, 'request log pruned');
  }
}
