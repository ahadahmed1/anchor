/* Tests for the data model. Run with `npm test`. No dependencies. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, normalize, CATEGORIES,
  addAsset, addItem, updateAsset, updateItem, logCompletion,
  deleteAsset, deleteItem, deleteEntry,
  findAsset, findItem, allItems, walkAssets,
  liveAssets, liveItems, liveLog, isLive,
  assetMileage, dueForAll,
} from '../js/model.js';

/** A small household: one car, one house with a furnace inside it. */
function household(){
  const s = emptyState();
  const car = addAsset(s, null, {name: '2019 Honda CR-V', category: 'car', fields: {mileage: 41000}});
  const home = addAsset(s, null, {name: '123 Main St', category: 'home'});
  const furnace = addAsset(s, home.id, {name: 'Furnace', category: 'appliance'});
  const oil = addItem(s, car.id, {
    name: 'Oil change', schedule: {type: 'interval', every: 5000, unit: 'miles'},
  });
  const filter = addItem(s, furnace.id, {
    name: 'Filter', schedule: {type: 'interval', every: 3, unit: 'months'},
  });
  return {s, car, home, furnace, oil, filter};
}

/* ---- construction and traversal ---------------------------------------------------------- */

test('assets nest, and items hang off any asset', () => {
  const {s, home, furnace, filter} = household();
  assert.equal(s.assets.length, 2, 'two top-level assets');
  assert.equal(liveAssets(home)[0].id, furnace.id, 'furnace is inside the house');
  assert.equal(liveItems(furnace)[0].id, filter.id);

  const names = [];
  walkAssets(s, ({asset, depth}) => names.push(`${'  '.repeat(depth)}${asset.name}`));
  assert.deepEqual(names, ['2019 Honda CR-V', '123 Main St', '  Furnace']);
});

test('every record is stamped and starts untombstoned', () => {
  const {car, oil} = household();
  for(const r of [car, oil]){
    assert.ok(r.id, 'has an id');
    assert.ok(r.createdAt, 'has createdAt');
    assert.ok(r.updatedAt, 'has updatedAt');
    assert.equal(r.deletedAt, null);
    assert.equal(isLive(r), true);
  }
});

test('ids are unique across records', () => {
  const {s} = household();
  const ids = [];
  walkAssets(s, ({asset}) => { ids.push(asset.id); for(const i of liveItems(asset)) ids.push(i.id); });
  assert.equal(new Set(ids).size, ids.length, 'no collisions');
});

test('an unknown category falls back rather than corrupting the record', () => {
  const s = emptyState();
  const a = addAsset(s, null, {name: 'Thing', category: 'spaceship'});
  assert.equal(a.category, 'other');
  assert.ok(CATEGORIES[a.category], 'always a real category');
});

test('adding to a missing parent returns null instead of throwing', () => {
  const s = emptyState();
  assert.equal(addAsset(s, 'nope', {name: 'x'}), null);
  assert.equal(addItem(s, 'nope', {name: 'x'}), null);
  assert.equal(updateItem(s, 'nope', {name: 'x'}), null);
  assert.equal(deleteAsset(s, 'nope'), null);
  assert.equal(logCompletion(s, 'nope', {}), null);
});

test('find locates assets and items anywhere in the tree', () => {
  const {s, furnace, filter, home} = household();
  assert.equal(findAsset(s, furnace.id).asset.name, 'Furnace');
  assert.equal(findAsset(s, furnace.id).parent.id, home.id, 'reports the parent');
  assert.equal(findAsset(s, home.id).parent, null, 'top level has no parent');
  const hit = findItem(s, filter.id);
  assert.equal(hit.item.name, 'Filter');
  assert.equal(hit.asset.id, furnace.id, 'items know their owning asset');
});

/* ---- updates ----------------------------------------------------------------------------- */

test('updates only touch permitted fields', async () => {
  const {s, oil} = household();
  const before = oil.updatedAt;
  await new Promise(r => setTimeout(r, 2));

  updateItem(s, oil.id, {name: 'Oil & filter', id: 'hacked', deletedAt: 'nope', log: []});
  const after = findItem(s, oil.id).item;
  assert.equal(after.name, 'Oil & filter');
  assert.equal(after.id, oil.id, 'id is not patchable');
  assert.equal(after.deletedAt, null, 'deletion is not patchable');
  assert.notEqual(after.updatedAt, before, 'updatedAt advanced');
});

test('updatedAt advances on every mutation', async () => {
  const {s, furnace, filter} = household();
  const stamps = [];
  const record = () => stamps.push(findAsset(s, furnace.id).asset.updatedAt);

  record();
  await new Promise(r => setTimeout(r, 2));
  addItem(s, furnace.id, {name: 'Service', schedule: null});
  record();
  await new Promise(r => setTimeout(r, 2));
  deleteItem(s, filter.id);
  record();

  assert.equal(new Set(stamps).size, 3, 'each change moved the parent stamp');
  assert.ok(stamps[0] < stamps[1] && stamps[1] < stamps[2], 'monotonic');
});

/* ---- soft deletion ----------------------------------------------------------------------- */

test('deleting an item tombstones it rather than removing it', () => {
  const {s, oil, car} = household();
  deleteItem(s, oil.id);

  const raw = findAsset(s, car.id).asset.items;
  assert.equal(raw.length, 1, 'still physically present — this is the whole point');
  assert.ok(raw[0].deletedAt, 'carries a tombstone');
  assert.equal(liveItems(findAsset(s, car.id).asset).length, 0, 'but invisible to live reads');
  assert.equal(findItem(s, oil.id), null, 'and unfindable');
  assert.equal(allItems(s).length, 1, 'only the furnace filter remains');
});

test('deleting an asset cascades tombstones to everything beneath it', () => {
  const {s, home, furnace, filter} = household();
  deleteAsset(s, home.id);

  assert.equal(liveAssets(s).length, 1, 'only the car is left at top level');
  /* The cascade is what makes a future per-record merge safe: each descendant carries its own
     deletion fact, so a device that never saw the parent go still resolves them as deleted. */
  const rawHome = s.assets.find(a => a.id === home.id);
  assert.ok(rawHome.deletedAt, 'parent tombstoned');
  assert.ok(rawHome.assets[0].deletedAt, 'nested asset tombstoned');
  assert.ok(rawHome.assets[0].items[0].deletedAt, 'its items tombstoned too');
  assert.equal(findItem(s, filter.id), null);
  assert.equal(findAsset(s, furnace.id), null);
});

test('deleting twice does not move the tombstone', async () => {
  const {s, oil} = household();
  const first = deleteItem(s, oil.id).deletedAt;
  await new Promise(r => setTimeout(r, 2));

  /* The second delete has to find the record despite it being tombstoned, so it goes through
     the raw array rather than findItem, which correctly refuses to see deleted records. */
  assert.equal(deleteItem(s, oil.id), null, 'already-deleted items are no longer findable');
  const raw = s.assets.flatMap(a => a.items).find(i => i.id === oil.id);
  assert.equal(raw.deletedAt, first, 'original deletion time is preserved');
});

test('log entries tombstone rather than disappear', () => {
  const {s, filter} = household();
  const a = logCompletion(s, filter.id, {date: '2026-01-10'});
  const b = logCompletion(s, filter.id, {date: '2026-04-10'});

  deleteEntry(s, filter.id, a.id);
  const item = findItem(s, filter.id).item;
  assert.equal(item.log.length, 2, 'both entries still physically present');
  assert.equal(liveLog(item).length, 1);
  assert.equal(liveLog(item)[0].id, b.id);
  assert.equal(deleteEntry(s, filter.id, 'nope'), null, 'unknown entry is a no-op');
});

/* ---- logging ----------------------------------------------------------------------------- */

test('logging a completion appends and stamps the item', async () => {
  const {s, filter} = household();
  const before = findItem(s, filter.id).item.updatedAt;
  await new Promise(r => setTimeout(r, 2));

  const entry = logCompletion(s, filter.id, {date: '2026-04-10', note: 'new filter', cost: '18'});
  assert.equal(entry.date, '2026-04-10');
  assert.equal(entry.note, 'new filter');
  assert.equal(entry.by, null, 'attribution exists but is unused until identity does');
  assert.ok(entry.id);
  assert.notEqual(findItem(s, filter.id).item.updatedAt, before);
});

test('logging mileage updates the asset odometer, because it is the same fact', () => {
  const {s, oil, car} = household();
  assert.equal(assetMileage(findAsset(s, car.id).asset), 41000);

  logCompletion(s, oil.id, {date: '2026-06-01', mileage: 43500});
  assert.equal(assetMileage(findAsset(s, car.id).asset), 43500, 'odometer moved with the log');
  assert.equal(liveLog(findItem(s, oil.id).item)[0].mileage, 43500, 'and the reading is kept in history');
});

test('a completion without mileage leaves the odometer alone', () => {
  const {s, oil, car} = household();
  logCompletion(s, oil.id, {date: '2026-06-01'});
  assert.equal(assetMileage(findAsset(s, car.id).asset), 41000);
});

test('assetMileage tolerates missing or junk readings', () => {
  assert.equal(assetMileage({fields: {}}), null);
  assert.equal(assetMileage({fields: {mileage: ''}}), null);
  assert.equal(assetMileage({fields: {mileage: 'lots'}}), null);
  assert.equal(assetMileage(undefined), null);
  assert.equal(assetMileage({fields: {mileage: '41000'}}), 41000, 'numeric strings are fine');
});

/* ---- derived views ----------------------------------------------------------------------- */

test('dueForAll resolves every live item against its own asset', () => {
  const {s, oil, filter} = household();
  logCompletion(s, oil.id, {date: '2026-01-01', mileage: 40000});
  logCompletion(s, filter.id, {date: '2026-04-10'});

  const rows = dueForAll(s, {now: new Date(2026, 5, 1)});
  assert.equal(rows.length, 2);

  const byName = Object.fromEntries(rows.map(r => [r.item.name, r]));
  /* Baseline 40,000 + 5,000 = 45,000, against the odometer the log just moved to 40,000. */
  assert.equal(byName['Oil change'].due.mileageRemaining, 5000);
  assert.equal(byName['Oil change'].asset.name, '2019 Honda CR-V', 'row carries its asset');
  assert.equal(byName['Filter'].due.date, '2026-07-10', 'April + 3 months');
});

test('dueForAll reports unknown for an item that cannot be tracked yet', () => {
  const s = emptyState();
  const car = addAsset(s, null, {name: 'Truck', category: 'car'});   // no odometer
  addItem(s, car.id, {name: 'Oil', schedule: {type: 'interval', every: 5000, unit: 'miles'}});

  const [row] = dueForAll(s, {now: new Date(2026, 5, 1)});
  assert.equal(row.due.state, 'unknown');
  assert.equal(row.due.reason, 'Odometer reading needed', 'feeds the Needs setup bucket');
});

test('dueForAll ignores deleted items and deleted log entries', () => {
  const {s, oil, filter} = household();
  deleteItem(s, oil.id);

  const bad = logCompletion(s, filter.id, {date: '2026-11-01'});
  logCompletion(s, filter.id, {date: '2026-04-10'});
  deleteEntry(s, filter.id, bad.id);

  const rows = dueForAll(s, {now: new Date(2026, 5, 1)});
  assert.equal(rows.length, 1, 'the deleted item is gone from the timeline');
  /* If the tombstoned November entry leaked through it would be read as the latest completion
     and push the due date to 2027-02-01. */
  assert.equal(rows[0].due.date, '2026-07-10', 'computed from the surviving April entry');
});

/* ---- normalize --------------------------------------------------------------------------- */

test('normalize rebuilds a valid tree and preserves tombstones', () => {
  const {s, oil} = household();
  logCompletion(s, oil.id, {date: '2026-02-02', mileage: 42000});
  deleteItem(s, oil.id);

  const round = normalize(JSON.parse(JSON.stringify(s)));
  assert.equal(round.assets.length, 2);
  const rawOil = round.assets[0].items.find(i => i.id === oil.id);
  assert.ok(rawOil.deletedAt, 'tombstone survived the round trip');
  assert.equal(rawOil.log[0].mileage, 42000, 'and so did the log');
  assert.equal(allItems(round).length, 1);
});

test('normalize drops junk instead of half-repairing it', () => {
  const out = normalize({assets: [
    {id: 'a1', name: 'Real', category: 'home', items: [{id: 'i1', name: 'ok'}, {name: 'no id'}]},
    {name: 'no id at all'},
    null,
  ]});
  assert.equal(out.assets.length, 1);
  assert.equal(out.assets[0].items.length, 1, 'the id-less item was dropped');
  assert.equal(out.assets[0].items[0].id, 'i1');
});

test('normalize handles absent, empty and malformed input', () => {
  for(const input of [null, undefined, {}, {assets: 'nope'}, 42, 'text']){
    const out = normalize(input);
    assert.deepEqual(out.assets, [], `${JSON.stringify(input)} yields an empty state`);
    assert.equal(out.version, 1);
  }
});

test('normalize fills in arrays the app assumes exist', () => {
  const out = normalize({assets: [{id: 'a1', name: 'Bare'}]});
  const a = out.assets[0];
  assert.deepEqual(a.assets, []);
  assert.deepEqual(a.items, []);
  assert.deepEqual(a.fields, {});
  assert.equal(a.deletedAt, null);
});
