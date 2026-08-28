/* Tests for the storage wrapper and the persistence bridge. Run with `npm test`. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/storage.js';
import { loadState, saveState, loadTheme, saveTheme, STATE_KEY } from '../js/persist.js';
import { emptyState, addAsset, addItem, logCompletion, allItems, deleteItem } from '../js/model.js';

/** A localStorage stand-in. `failOn` makes setItem throw, standing in for a quota error. */
function fakeLocalStorage(opts = {}){
  const map = new Map();
  return {
    failOn: opts.failOn || null,
    get length(){ return map.size; },
    key(i){ return [...map.keys()][i] ?? null; },
    getItem(k){ return map.has(k) ? map.get(k) : null; },
    setItem(k, v){
      if(this.failOn && k.includes(this.failOn)) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem(k){ map.delete(k); },
    _dump: map,
  };
}

/* ---- the wrapper ------------------------------------------------------------------------- */

test('round-trips values under the anchor: prefix', () => {
  const ls = fakeLocalStorage();
  const store = createStore(ls);
  store.setSync('greeting', 'hello');

  assert.equal(store.getSync('greeting'), 'hello');
  assert.equal(ls.getItem('anchor:greeting'), 'hello', 'namespaced on the way in');
  assert.equal(store.persistent, true);
  assert.equal(store.getSync('nothing'), null, 'missing keys read as null');
});

test('does not collide with the old app\'s data', () => {
  const ls = fakeLocalStorage();
  ls.setItem('projectLedger:domains', '[{"legacy":true}]');
  const store = createStore(ls);

  assert.equal(store.getSync('domains'), null, 'old data is invisible, not imported');
  assert.equal(ls.getItem('projectLedger:domains'), '[{"legacy":true}]', 'and left untouched');
});

test('falls back to memory when there is no localStorage at all', async () => {
  const store = createStore(null);
  assert.equal(store.persistent, false);

  assert.equal(store.setSync('k', 'v'), false, 'reports the write as not durable');
  assert.equal(store.getSync('k'), 'v', 'but the value is usable this session');
  await assert.rejects(store.set('k2', 'v2'), /storage unavailable/);
  assert.equal(store.getSync('k2'), 'v2', 'even the rejected write is readable');
});

test('REGRESSION: a failed write is not shadowed by a stale stored value', () => {
  /* The old implementation wrote to memory, returned false, then kept reading localStorage —
     so after a quota error the previous value came back and the write vanished mid-session. */
  const ls = fakeLocalStorage();
  const store = createStore(ls);
  store.setSync('doc', 'first');
  assert.equal(store.getSync('doc'), 'first');

  ls.failOn = 'doc';
  assert.equal(store.setSync('doc', 'second'), false, 'write reported as failed');
  assert.equal(store.getSync('doc'), 'second', 'and yet the new value is what you read back');
  assert.equal(ls.getItem('anchor:doc'), 'first', 'durable copy is genuinely still the old one');
  assert.deepEqual(store.pending, ['doc'], 'the discrepancy is reportable');

  ls.failOn = null;
  assert.equal(store.setSync('doc', 'third'), true);
  assert.deepEqual(store.pending, [], 'recovers once writes land again');
  assert.equal(ls.getItem('anchor:doc'), 'third');
});

test('remove clears both layers', () => {
  const ls = fakeLocalStorage();
  const store = createStore(ls);
  store.setSync('k', 'v');
  store.removeSync('k');
  assert.equal(store.getSync('k'), null);
  assert.equal(ls.getItem('anchor:k'), null);
});

test('storage disappearing mid-session degrades instead of throwing', () => {
  const ls = fakeLocalStorage();
  const store = createStore(ls);
  store.setSync('k', 'v');

  ls.getItem = () => { throw new Error('SecurityError'); };
  assert.equal(store.getSync('k'), 'v', 'served from memory');
  assert.equal(store.persistent, false, 'and it stops claiming to be durable');
});

test('the async surface mirrors the sync one', async () => {
  const store = createStore(fakeLocalStorage());
  await store.set('k', 'v');
  assert.equal(await store.get('k'), 'v');
  await store.remove('k');
  assert.equal(await store.get('k'), null);
});

/* ---- the bridge -------------------------------------------------------------------------- */

test('a first run loads an empty state', () => {
  const {state, status} = loadState(createStore(fakeLocalStorage()));
  assert.equal(status, 'empty');
  assert.deepEqual(state.assets, []);
});

test('state round-trips through save and load', () => {
  const store = createStore(fakeLocalStorage());
  const s = emptyState();
  const car = addAsset(s, null, {name: 'Honda', category: 'car', fields: {mileage: 41000}});
  const oil = addItem(s, car.id, {name: 'Oil change', schedule: {type: 'interval', every: 5000, unit: 'miles'}});
  logCompletion(s, oil.id, {date: '2026-01-01', mileage: 40000});

  assert.deepEqual(saveState(s, store), {ok: true, reason: null});

  const {state, status} = loadState(store);
  assert.equal(status, 'loaded');
  assert.equal(state.assets.length, 1);
  assert.equal(state.assets[0].fields.mileage, 40000, 'odometer written through by the log');
  assert.equal(allItems(state).length, 1);
  assert.equal(allItems(state)[0].item.log[0].date, '2026-01-01');
});

test('tombstones survive a save/load cycle', () => {
  const store = createStore(fakeLocalStorage());
  const s = emptyState();
  const car = addAsset(s, null, {name: 'Honda', category: 'car'});
  const a = addItem(s, car.id, {name: 'Keep', schedule: null});
  const b = addItem(s, car.id, {name: 'Drop', schedule: null});
  deleteItem(s, b.id);
  saveState(s, store);

  const {state} = loadState(store);
  assert.equal(allItems(state).length, 1, 'only the live item is visible');
  assert.equal(allItems(state)[0].item.id, a.id);
  assert.equal(state.assets[0].items.length, 2, 'but the tombstone is still on disk');
  assert.ok(state.assets[0].items.find(i => i.id === b.id).deletedAt);
});

test('corrupt saved data is set aside, not overwritten', () => {
  const ls = fakeLocalStorage();
  const store = createStore(ls);
  ls.setItem('anchor:state', '{"assets":[{"id":"a1"} <- truncated');

  const {state, status, detail} = loadState(store);
  assert.equal(status, 'corrupt');
  assert.deepEqual(state.assets, [], 'starts empty rather than throwing');
  assert.ok(detail && detail.startsWith(`${STATE_KEY}.corrupt.`), 'names where the copy went');
  assert.match(ls.getItem('anchor:' + detail), /truncated/, 'the original bytes are recoverable');
});

test('valid JSON of the wrong shape normalizes instead of being called corrupt', () => {
  const ls = fakeLocalStorage();
  const store = createStore(ls);
  ls.setItem('anchor:state', '{"nonsense":true}');

  const {state, status} = loadState(store);
  assert.equal(status, 'loaded', 'it parsed — normalize deals with the shape');
  assert.deepEqual(state.assets, []);
});

test('saveState reports an unavailable store rather than pretending', () => {
  const store = createStore(null);
  const result = saveState(emptyState(), store);
  assert.deepEqual(result, {ok: false, reason: 'unavailable'});
  assert.equal(loadState(store).status, 'loaded', 'though it is still readable this session');
});

test('saveState distinguishes an encoding bug from a storage failure', () => {
  const store = createStore(fakeLocalStorage());
  const cyclic = emptyState();
  cyclic.self = cyclic;
  assert.deepEqual(saveState(cyclic, store), {ok: false, reason: 'encode'});
});

test('saved state carries a version', () => {
  const ls = fakeLocalStorage();
  const store = createStore(ls);
  saveState(emptyState(), store);
  assert.equal(JSON.parse(ls.getItem('anchor:state')).version, 1);
});

test('theme has its own synchronous path', () => {
  const store = createStore(fakeLocalStorage());
  assert.equal(loadTheme(store), null);
  saveTheme('dark', store);
  assert.equal(loadTheme(store), 'dark', 'readable before first paint, no JSON involved');
});
