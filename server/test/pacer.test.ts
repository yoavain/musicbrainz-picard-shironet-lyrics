import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, Pacer, initialState, loadPace, savePace } from '../src/pacer.ts';
import { Store } from '../src/store.ts';

const fixed = (value: number) => () => value; // random() in [0, 1)

describe('Pacer', () => {
  test('starts at the start interval with jitter of +-20%', () => {
    const low = new Pacer(initialState(DEFAULT_LIMITS), DEFAULT_LIMITS, fixed(0));
    const high = new Pacer(initialState(DEFAULT_LIMITS), DEFAULT_LIMITS, fixed(0.999999));
    assert.equal(low.nextWait(0), 8);
    assert.ok(Math.abs(high.nextWait(0) - 12) < 0.001);
  });
  test('never waits less than the hard minimum, whatever the jitter', () => {
    const state = { ...initialState(DEFAULT_LIMITS), interval: 5 };
    assert.equal(new Pacer(state, DEFAULT_LIMITS, fixed(0)).nextWait(0), 5);
  });
  test('speeds up 10% after 5 successes in a row, down to the minimum', () => {
    const pacer = new Pacer(initialState(DEFAULT_LIMITS), DEFAULT_LIMITS, fixed(0.5));
    for (let i = 0; i < 4; i += 1) pacer.onSuccess(0);
    assert.equal(pacer.state.interval, 10);
    pacer.onSuccess(0);
    assert.equal(pacer.state.interval, 9);
    for (let i = 0; i < 200; i += 1) pacer.onSuccess(0);
    assert.equal(pacer.state.interval, 5);
  });
  test('a challenge slows down 50%, doubles the cooldown and sets a floor', () => {
    const pacer = new Pacer(initialState(DEFAULT_LIMITS), DEFAULT_LIMITS, fixed(0.5));
    assert.equal(pacer.onChallenge(1000), 1800);
    assert.equal(pacer.state.interval, 15);
    assert.equal(pacer.state.cooldown, 3600);
    assert.equal(pacer.state.floor, 12);
    assert.equal(pacer.onChallenge(2000), 3600); // still challenged: cooldown keeps doubling
    assert.deepEqual(pacer.state.challenges.map((c) => c.interval), [10, 15]);
  });
  test('the first success after a challenge resets the cooldown', () => {
    const pacer = new Pacer(initialState(DEFAULT_LIMITS), DEFAULT_LIMITS, fixed(0.5));
    pacer.onChallenge(0);
    pacer.onSuccess(10);
    assert.equal(pacer.state.cooldown, DEFAULT_LIMITS.baseCooldown);
    assert.equal(pacer.state.challenged, false);
  });
  test('the floor stops speeding up, then decays over 24 h', () => {
    const pacer = new Pacer(initialState(DEFAULT_LIMITS), DEFAULT_LIMITS, fixed(0.5));
    pacer.onChallenge(0); // interval 15, floor 12
    for (let i = 0; i < 100; i += 1) pacer.onSuccess(10);
    // Held at the floor (12, minus 10 s of decay out of 24 h).
    assert.ok(Math.abs(pacer.state.interval - 12) < 0.01, String(pacer.state.interval));
    assert.equal(pacer.effectiveFloor(43200), 8.5); // halfway: 5 + (12 - 5) / 2
    assert.equal(pacer.effectiveFloor(86400), 5);
    for (let i = 0; i < 100; i += 1) pacer.onSuccess(90000);
    assert.equal(pacer.state.interval, 5);
  });
  test('an error waits twice the interval and keeps the pace', () => {
    const pacer = new Pacer(initialState(DEFAULT_LIMITS), DEFAULT_LIMITS, fixed(0.5));
    assert.equal(pacer.onError(), 20);
    assert.equal(pacer.state.interval, 10);
  });
  test('only the last 20 challenges are kept', () => {
    const pacer = new Pacer(initialState(DEFAULT_LIMITS), DEFAULT_LIMITS, fixed(0.5));
    for (let i = 0; i < 25; i += 1) pacer.onChallenge(i);
    assert.equal(pacer.state.challenges.length, 20);
    assert.equal(pacer.state.challenges[0].at, 5);
  });
});

describe('pace in meta', () => {
  test('save and load survive a new Pacer (restart)', () => {
    const store = new Store(':memory:');
    const pacer = new Pacer(loadPace(store, DEFAULT_LIMITS), DEFAULT_LIMITS);
    pacer.onChallenge(100);
    savePace(store, pacer.state);
    const again = loadPace(store, DEFAULT_LIMITS);
    assert.deepEqual(again, pacer.state);
    store.close();
  });
  test('missing or broken meta gives the initial state', () => {
    const store = new Store(':memory:');
    assert.deepEqual(loadPace(store, DEFAULT_LIMITS), initialState(DEFAULT_LIMITS));
    store.setJson('pace', { interval: 'fast' });
    assert.deepEqual(loadPace(store, DEFAULT_LIMITS), initialState(DEFAULT_LIMITS));
    store.close();
  });
});
