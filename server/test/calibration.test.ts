import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertReason, calibrationReport, countFetch, enqueueCalibration, enqueueSample, fetchesSinceSample, pickSample,
  resetCounter, similarity,
} from '../src/calibration.ts';
import { SOURCE_EMBEDDED, SOURCE_SHIRONET, Store } from '../src/store.ts';
import * as queue from '../src/queue.ts';

const NOW = '2026-10-07T12:00:00+00:00';

describe('similarity', () => {
  test('same words give 1, whitespace ignored', () => {
    assert.equal(similarity('שורה  ראשונה\nשורה שנייה', 'שורה ראשונה שורה שנייה'), 1);
  });
  test('one changed word out of four', () => {
    assert.equal(similarity('א ב ג ד', 'א ב ג ה'), 0.75);
  });
  test('empty texts', () => {
    assert.equal(similarity('', ''), 1);
    assert.equal(similarity('א', ''), 0);
  });
});

describe('calibration bookkeeping', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  test('pickSample takes embedded songs only, never one with a fetch row', () => {
    store.put('אמן', 'משלי', 'שורה', SOURCE_EMBEDDED);
    store.put('אמן', 'משירונט', 'שורה', SOURCE_SHIRONET);
    assert.deepEqual(pickSample(store, NOW, 90), { artist: 'אמן', title: 'משלי' });
    queue.insert(store, [{ artist: 'אמן', title: 'משלי' }], 'bulk', NOW);
    assert.equal(pickSample(store, NOW, 90), undefined);
  });
  test('a song calibrated within the gap is not picked again', () => {
    store.put('אמן', 'שיר', 'שורה', SOURCE_EMBEDDED);
    enqueueSample(store, { artist: 'אמן', title: 'שיר' }, NOW);
    assert.equal(pickSample(store, NOW, 90), undefined);
    assert.deepEqual(pickSample(store, '2027-02-01T12:00:00+00:00', 90), { artist: 'אמן', title: 'שיר' });
  });
  test('enqueueSample resets an old calibration row to pending', () => {
    store.put('אמן', 'שיר', 'שורה', SOURCE_EMBEDDED);
    enqueueSample(store, { artist: 'אמן', title: 'שיר' }, NOW);
    queue.markDone(store, queue.nextCalibration(store)!, 'similarity 0.90', NOW);
    assert.equal(queue.nextCalibration(store), undefined);
    enqueueSample(store, { artist: 'אמן', title: 'שיר' }, '2027-02-01T12:00:00+00:00');
    assert.equal(queue.nextCalibration(store)?.status, 'pending');
  });
  test('enqueueCalibration queues up to count distinct songs', () => {
    store.put('אמן', 'א', 'שורה', SOURCE_EMBEDDED);
    store.put('אמן', 'ב', 'שורה', SOURCE_EMBEDDED);
    assert.equal(enqueueCalibration(store, 5, NOW, 90), 2);
  });
  test('the fetch counter lives in meta', () => {
    assert.equal(fetchesSinceSample(store), 0);
    countFetch(store);
    countFetch(store);
    assert.equal(fetchesSinceSample(store), 2);
    resetCounter(store);
    assert.equal(fetchesSinceSample(store), 0);
  });
  test('report and alerts', () => {
    const scores = [0.95, 0.5, 0.6, 0.55, 0.7, 0.65, 0.6, 0.5, 0.45, 0.7];
    scores.forEach((score, index) => {
      store.put('אמן', `שיר ${index}`, 'שורה', SOURCE_EMBEDDED);
      enqueueSample(store, { artist: 'אמן', title: `שיר ${index}` }, `2026-10-07T12:00:${String(index).padStart(2, '0')}+00:00`);
      queue.markDone(store, queue.nextCalibration(store)!, `similarity ${score.toFixed(2)}`, `2026-10-07T13:00:${String(index).padStart(2, '0')}+00:00`);
    });
    const report = calibrationReport(store);
    assert.equal(report.samples.length, 10);
    assert.equal(report.samples[0].similarity, 0.7); // newest first
    assert.equal(report.lowest, 0.45);
    assert.equal(report.median, 0.6);
    assert.match(alertReason(store, 0.8) ?? '', /median/);
  });
  test('three misses in a row alert', () => {
    for (let index = 0; index < 3; index += 1) {
      store.put('אמן', `חסר ${index}`, 'שורה', SOURCE_EMBEDDED);
      enqueueSample(store, { artist: 'אמן', title: `חסר ${index}` }, NOW);
      queue.markNotFound(store, queue.nextCalibration(store)!, 'no match', NOW, `2026-10-07T13:00:0${index}+00:00`);
    }
    assert.match(alertReason(store, 0.8) ?? '', /not found/);
    assert.equal(calibrationReport(store).notFound, 3);
  });
  test('the median alert counts scored samples even when some were not found', () => {
    let second = 0;
    const at = () => '2026-10-07T13:' + String(Math.floor(second / 60)).padStart(2, '0') + ':' + String(second++ % 60).padStart(2, '0') + '+00:00';
    for (let index = 0; index < 13; index += 1) {
      store.put('אמן', 'מעורב ' + index, 'שורה', SOURCE_EMBEDDED);
      enqueueSample(store, { artist: 'אמן', title: 'מעורב ' + index }, NOW);
      const row = queue.nextCalibration(store)!;
      if (index % 4 === 1) queue.markNotFound(store, row, 'no match', NOW, at());
      else queue.markDone(store, row, 'similarity 0.40', at());
    }
    assert.match(alertReason(store, 0.8) ?? '', /median/);
  });
  test('no samples, no alert', () => {
    assert.equal(alertReason(store, 0.8), null);
  });
});
