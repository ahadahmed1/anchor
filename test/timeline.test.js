/* Tests for timeline bucketing. Run with `npm test`. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketFor, groupIntoBuckets, buildTimeline, relativeDue, shortDue, BUCKET_KEYS,
} from '../js/timeline.js';
import { emptyState, addAsset, addItem, logCompletion, deleteItem } from '../js/model.js';

const row = (name, due) => ({item: {name}, asset: {name: 'Asset'}, due});
const dated = (state, days) => ({state, days, date: '2026-01-01', mileageRemaining: null});
const miles = (state, mileageRemaining) => ({state, days: null, date: null, mileageRemaining});

/* ---- bucketFor --------------------------------------------------------------------------- */

test('each due state lands in the right bucket', () => {
  assert.equal(bucketFor(dated('overdue', -12)), 'overdue');
  assert.equal(bucketFor(dated('due_soon', 3)), 'due_soon');
  assert.equal(bucketFor(dated('upcoming', 20)), 'this_month');
  assert.equal(bucketFor(dated('upcoming', 200)), 'later');
  assert.equal(bucketFor({state: 'unknown', reason: 'Odometer reading needed'}), 'needs_setup');
  assert.equal(bucketFor({state: 'done'}), 'done');
  assert.equal(bucketFor(null), 'needs_setup', 'a missing due state is a setup problem');
});

test('the month horizon is inclusive at 31 days', () => {
  assert.equal(bucketFor(dated('upcoming', 31)), 'this_month');
  assert.equal(bucketFor(dated('upcoming', 32)), 'later');
});

test('mileage items bucket by state, since they have no date', () => {
  assert.equal(bucketFor(miles('overdue', -500)), 'overdue');
  assert.equal(bucketFor(miles('due_soon', 80)), 'due_soon', 'not forced into a calendar week');
  assert.equal(bucketFor(miles('upcoming', 4000)), 'later');
});

/* ---- grouping and ordering --------------------------------------------------------------- */

test('buckets come back in reading order, empties omitted', () => {
  const buckets = groupIntoBuckets([
    row('Later thing', dated('upcoming', 200)),
    row('Overdue thing', dated('overdue', -3)),
    row('Soon thing', dated('due_soon', 2)),
  ]);
  assert.deepEqual(buckets.map(b => b.key), ['overdue', 'due_soon', 'later']);
  assert.equal(buckets.every(b => b.rows.length > 0), true);
});

test('most urgent sorts to the top within a bucket', () => {
  const buckets = groupIntoBuckets([
    row('Least', dated('overdue', -2)),
    row('Most', dated('overdue', -90)),
    row('Middle', dated('overdue', -30)),
  ]);
  assert.deepEqual(buckets[0].rows.map(r => r.item.name), ['Most', 'Middle', 'Least']);
});

test('date and mileage items share a bucket without being compared', () => {
  /* Days and miles are not commensurable, so dated items lead and mileage items follow,
     each internally ordered rather than interleaved on raw numbers. */
  const buckets = groupIntoBuckets([
    row('Miles far', miles('overdue', -50)),
    row('Days', dated('overdue', -5)),
    row('Miles near', miles('overdue', -900)),
  ]);
  assert.deepEqual(buckets[0].rows.map(r => r.item.name), ['Days', 'Miles near', 'Miles far']);
});

test('ties break on name so ordering is stable', () => {
  const buckets = groupIntoBuckets([
    row('Zebra', dated('overdue', -5)),
    row('Apple', dated('overdue', -5)),
  ]);
  assert.deepEqual(buckets[0].rows.map(r => r.item.name), ['Apple', 'Zebra']);
});

test('the Done bucket is marked collapsible and sorts last', () => {
  const buckets = groupIntoBuckets([
    row('Finished', {state: 'done'}),
    row('Live', dated('overdue', -1)),
  ]);
  assert.deepEqual(buckets.map(b => b.key), ['overdue', 'done']);
  assert.equal(buckets.find(b => b.key === 'done').collapsed, true);
});

test('an empty input produces no buckets at all', () => {
  assert.deepEqual(groupIntoBuckets([]), []);
  assert.deepEqual(groupIntoBuckets(undefined), []);
});

/* ---- buildTimeline over real state -------------------------------------------------------- */

/* createdAt is pinned well in the past. Left to the real clock, these records would be created
   "after" the injected `now`, and the engine would correctly decline to call a fixed-date item
   overdue for a cycle that predates its own existence. */
const LONG_AGO = '2024-01-01T00:00:00.000Z';

function household(){
  const s = emptyState();
  const car = addAsset(s, null, {name: 'Honda', category: 'car', fields: {mileage: 41000}, createdAt: LONG_AGO});
  const home = addAsset(s, null, {name: 'House', category: 'home', createdAt: LONG_AGO});
  const oil = addItem(s, car.id, {name: 'Oil change', createdAt: LONG_AGO, schedule: {type: 'interval', every: 5000, unit: 'miles'}});
  const gutters = addItem(s, home.id, {name: 'Gutters', createdAt: LONG_AGO, schedule: {type: 'interval', every: 12, unit: 'months'}});
  const reg = addItem(s, car.id, {name: 'Registration', createdAt: LONG_AGO, schedule: {type: 'fixed', month: 3, day: 1}});
  return {s, car, home, oil, gutters, reg};
}

test('buildTimeline assembles a real household', () => {
  const {s, oil, gutters} = household();
  logCompletion(s, oil.id, {date: '2026-01-01', mileage: 40000});   // target 45,000 vs 40,000
  logCompletion(s, gutters.id, {date: '2025-06-01'});               // due 2026-06-01

  const t = buildTimeline(s, {now: new Date(2026, 5, 15)});         // 2026-06-15
  const keys = t.buckets.map(b => b.key);

  assert.equal(t.total, 3);
  assert.ok(keys.includes('overdue'), 'gutters are two weeks past due');
  const overdue = t.buckets.find(b => b.key === 'overdue').rows.map(r => r.item.name);
  assert.ok(overdue.includes('Gutters'));
  assert.ok(overdue.includes('Registration'), 'March 1 passed and was never logged');
  assert.equal(t.counts.overdue, 2);
  assert.equal(t.needsAttention, 2);
});

test('an item that cannot be tracked surfaces in Needs setup, not at the bottom of Later', () => {
  const s = emptyState();
  const car = addAsset(s, null, {name: 'Truck', category: 'car'});  // no odometer
  addItem(s, car.id, {name: 'Oil', schedule: {type: 'interval', every: 5000, unit: 'miles'}});

  const t = buildTimeline(s, {now: new Date(2026, 5, 15)});
  const setup = t.buckets.find(b => b.key === 'needs_setup');
  assert.equal(setup.rows.length, 1);
  assert.equal(setup.rows[0].due.reason, 'Odometer reading needed');
  assert.equal(t.needsAttention, 0, 'it needs setup, but it is not overdue');
});

test('nextUp gives an otherwise-empty screen something to say', () => {
  const s = emptyState();
  const home = addAsset(s, null, {name: 'House', category: 'home'});
  const g = addItem(s, home.id, {name: 'Gutters', schedule: {type: 'interval', every: 12, unit: 'months'}});
  logCompletion(s, g.id, {date: '2026-06-01'});

  const t = buildTimeline(s, {now: new Date(2026, 5, 15)});
  assert.equal(t.needsAttention, 0, 'nothing is pressing');
  assert.equal(t.nextUp.item.name, 'Gutters');
  assert.equal(t.nextUp.due.date, '2027-06-01');
});

test('nextUp is null when there is nothing at all', () => {
  const t = buildTimeline(emptyState(), {now: new Date(2026, 5, 15)});
  assert.deepEqual(t.buckets, []);
  assert.equal(t.nextUp, null);
  assert.equal(t.total, 0);
});

test('deleted items never reach the timeline', () => {
  const {s, oil, gutters} = household();
  logCompletion(s, gutters.id, {date: '2020-01-01'});
  deleteItem(s, gutters.id);
  deleteItem(s, oil.id);

  const t = buildTimeline(s, {now: new Date(2026, 5, 15)});
  assert.equal(t.total, 1, 'only Registration is left');
  assert.equal(t.buckets.flatMap(b => b.rows).some(r => r.item.name === 'Gutters'), false);
});

test('every bucket key is one the view knows how to render', () => {
  const {s} = household();
  const t = buildTimeline(s, {now: new Date(2026, 5, 15)});
  for(const b of t.buckets) assert.ok(BUCKET_KEYS.includes(b.key), `${b.key} is a known bucket`);
});

/* ---- wording ----------------------------------------------------------------------------- */

test('relativeDue reads like a person wrote it', () => {
  assert.equal(relativeDue(dated('due_soon', 0)), 'today');
  assert.equal(relativeDue(dated('due_soon', 1)), 'tomorrow');
  assert.equal(relativeDue(dated('due_soon', 5)), 'in 5 days');
  assert.equal(relativeDue(dated('overdue', -1)), '1 day overdue', 'singular');
  assert.equal(relativeDue(dated('overdue', -12)), '12 days overdue');
  assert.equal(relativeDue(dated('upcoming', 21)), 'in 3 weeks');
  assert.equal(relativeDue(dated('upcoming', 90)), 'in 3 months');
  assert.equal(relativeDue(miles('upcoming', 4000)), 'in 4,000 miles');
  assert.equal(relativeDue(miles('overdue', -1000)), '1,000 miles overdue');
  assert.equal(relativeDue({state: 'done'}), 'done');
  assert.equal(relativeDue({state: 'unknown', reason: 'Odometer reading needed'}),
    'Odometer reading needed', 'the reason IS the message');
  assert.equal(relativeDue(null), '');
});

test('shortDue is compact enough for a list row', () => {
  assert.equal(shortDue(dated('overdue', -12)), '-12d');
  assert.equal(shortDue(dated('due_soon', 3)), '3d');
  assert.equal(shortDue(miles('upcoming', 4000)), '4,000mi');
  assert.equal(shortDue({state: 'done'}), '✓');
  assert.equal(shortDue({state: 'unknown'}), '—');
});
