import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findWork, getArtist, isFresh, saveArtistSearch, saveWorks, worksCount } from '../src/artists.ts';
import { SCHEMA_VERSION, Store } from '../src/store.ts';
import { BASE_URL } from '../src/shironet.ts';

const T1 = '2026-10-07T10:00:00+00:00';
const T2 = '2026-10-08T10:00:00+00:00';
const url = (wrkid: number) => `${BASE_URL}/artist?type=lyrics&lang=1&prfid=41&wrkid=${wrkid}`;

describe('artist cache', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  test('the schema has the artist tables (migration 2)', () => {
    assert.ok(SCHEMA_VERSION >= 2);
    assert.equal(store.schemaVersion, SCHEMA_VERSION);
    assert.equal(worksCount(store, 41), 0);
  });
  test('an artist search result, and an artist not on Shironet, by normalized name', () => {
    saveArtistSearch(store, 'אביתר בנאי', { name: 'אביתר בנאי', prfid: 41 }, T1);
    saveArtistSearch(store, 'Unknown Band', null, T1);
    assert.deepEqual(getArtist(store, 'אביתר  בנאי!'), { prfid: 41, name: 'אביתר בנאי', searchedAt: T1, worksAt: null });
    assert.deepEqual(getArtist(store, 'unknown band'), { prfid: null, name: null, searchedAt: T1, worksAt: null });
    assert.equal(getArtist(store, 'מישהו אחר'), undefined);
  });
  test('works replace the old list and mark every name of that artist', () => {
    saveArtistSearch(store, 'אביתר בנאי', { name: 'אביתר בנאי', prfid: 41 }, T1);
    saveArtistSearch(store, 'Eviatar Banai', { name: 'אביתר בנאי', prfid: 41 }, T1);
    saveWorks(store, 41, [{ title: 'אבא', url: url(1) }, { title: 'ישן', url: url(2) }], T1);
    saveWorks(store, 41, [{ title: 'אבא', url: url(1) }, { title: 'בשבילך', url: url(14352) }], T2);
    assert.equal(worksCount(store, 41), 2);
    assert.equal(findWork(store, 41, ['ישן']), null);
    assert.equal(getArtist(store, 'Eviatar Banai')?.worksAt, T2);
  });
  test('findWork: titles normalized; the first title that matches wins; duplicates pick the lowest URL', () => {
    saveWorks(store, 41, [
      { title: 'בִּשְׁבִילֵךְ', url: url(14352) }, { title: 'יפה כלבנה', url: url(35987) }, { title: 'יפה כלבנה', url: url(35962) },
    ], T1);
    assert.deepEqual(findWork(store, 41, ['לא קיים', 'בשבילך']), { title: 'בִּשְׁבִילֵךְ', url: url(14352) });
    assert.deepEqual(findWork(store, 41, ['יפה כלבנה']), { title: 'יפה כלבנה', url: url(35962) });
    assert.equal(findWork(store, 99, ['בשבילך']), null);
  });
  test('a new artist search with another prfid forgets that the works were read', () => {
    saveArtistSearch(store, 'אמן', { name: 'אמן', prfid: 41 }, T1);
    saveWorks(store, 41, [], T1);
    saveArtistSearch(store, 'אמן', { name: 'אמן', prfid: 42 }, T2);
    assert.deepEqual(getArtist(store, 'אמן'), { prfid: 42, name: 'אמן', searchedAt: T2, worksAt: null });
  });
  test('isFresh', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    assert.equal(isFresh(T1, now, 30), true);
    assert.equal(isFresh(T1, now, 10), false);
    assert.equal(isFresh(null, now, 30), false);
  });
});
