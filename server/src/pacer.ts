// The pace of requests to Shironet. Starts fast and adapts from results:
// faster after a run of successes, slower after a challenge, with a learned floor
// that decays. The state lives in meta, so it survives a restart.

import type { Store } from './store.ts';

export interface PaceLimits {
  startInterval: number;
  minInterval: number;
  maxInterval: number;
  baseCooldown: number;
  maxCooldown: number;
  speedupAfter: number;
  floorDecaySeconds: number;
}

export const DEFAULT_LIMITS: PaceLimits = {
  startInterval: 10,
  minInterval: 5,
  maxInterval: 1800,
  baseCooldown: 1800,
  maxCooldown: 8 * 3600,
  speedupAfter: 5,
  floorDecaySeconds: 24 * 3600,
};

export interface PaceState {
  interval: number;
  cooldown: number;
  streak: number;
  /** True from a challenge until the next success. */
  challenged: boolean;
  /** The interval below which the pacer does not speed up; decays to minInterval. */
  floor: number;
  floorSetAt: number | null;
  /** The last challenges, with the interval each one came at. */
  challenges: Array<{ at: number; interval: number }>;
  /** No request before this time (Unix seconds): the cooldown deadline, kept across restarts. */
  cooldownUntil: number | null;
}

const MAX_CHALLENGES_KEPT = 20;
export const PACE_META_KEY = 'pace';

export function initialState(limits: PaceLimits): PaceState {
  return {
    interval: limits.startInterval, cooldown: limits.baseCooldown, streak: 0, challenged: false,
    floor: limits.minInterval, floorSetAt: null, challenges: [], cooldownUntil: null,
  };
}

export class Pacer {
  readonly state: PaceState;
  private readonly limits: PaceLimits;
  private readonly random: () => number;

  constructor(state: PaceState, limits: PaceLimits, random: () => number = Math.random) {
    this.state = state;
    this.limits = limits;
    this.random = random;
  }

  /** The floor at `now`: decays linearly from its value to minInterval over floorDecaySeconds. */
  effectiveFloor(now: number): number {
    const { floor, floorSetAt } = this.state;
    const { minInterval, floorDecaySeconds } = this.limits;
    if (floorSetAt === null || floor <= minInterval) return minInterval;
    const left = Math.max(0, 1 - (now - floorSetAt) / floorDecaySeconds);
    return minInterval + (floor - minInterval) * left;
  }

  /** Seconds to wait before the next request: the interval with +-20% jitter, never under the minimum. */
  nextWait(now: number): number {
    const base = Math.max(this.state.interval, this.effectiveFloor(now));
    return Math.max(this.limits.minInterval, base * (0.8 + 0.4 * this.random()));
  }

  onSuccess(now: number): void {
    const state = this.state;
    if (state.challenged) {
      state.challenged = false;
      state.cooldown = this.limits.baseCooldown;
    }
    state.streak += 1;
    if (state.streak >= this.limits.speedupAfter) {
      state.interval = Math.max(this.effectiveFloor(now), this.limits.minInterval, state.interval * 0.9);
      state.streak = 0;
    }
  }

  /** Seconds to wait (the cooldown) before the next request. */
  onChallenge(now: number): number {
    const state = this.state;
    const wait = state.cooldown;
    state.challenges.push({ at: now, interval: state.interval });
    if (state.challenges.length > MAX_CHALLENGES_KEPT) state.challenges.splice(0, state.challenges.length - MAX_CHALLENGES_KEPT);
    state.floor = Math.min(this.limits.maxInterval, state.interval * 1.2);
    state.floorSetAt = now;
    state.cooldownUntil = now + wait;
    state.cooldown = Math.min(this.limits.maxCooldown, state.cooldown * 2);
    state.interval = Math.min(this.limits.maxInterval, state.interval * 1.5);
    state.streak = 0;
    state.challenged = true;
    return wait;
  }

  /** A person solved the CAPTCHA: requests may go on before the cooldown ends. */
  clearCooldown(): void {
    this.state.cooldownUntil = null;
  }

  /** Seconds to wait after a network error. The pace stays. */
  onError(): number {
    return this.state.interval * 2;
  }
}

function isPaceState(value: unknown): value is PaceState {
  const v = value as Partial<PaceState> | null;
  return !!v && typeof v.interval === 'number' && typeof v.cooldown === 'number' && typeof v.streak === 'number'
    && typeof v.challenged === 'boolean' && typeof v.floor === 'number'
    && (v.floorSetAt === null || typeof v.floorSetAt === 'number') && Array.isArray(v.challenges);
}

export function loadPace(store: Store, limits: PaceLimits): PaceState {
  const saved = store.getJson<unknown>(PACE_META_KEY);
  // cooldownUntil came later: a saved state without it has no cooldown running.
  return isPaceState(saved) ? { ...saved, cooldownUntil: saved.cooldownUntil ?? null } : initialState(limits);
}

export function savePace(store: Store, state: PaceState): void {
  store.setJson(PACE_META_KEY, state);
}
