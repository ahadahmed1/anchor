/* Tests for the view. These assert on HTML strings, which is possible because the view is pure
   and never touches the DOM. Run with `npm test`. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml, renderRow, renderBucket, renderTimeline, renderAllClear, renderEmpty,
  renderAssets, renderTabs, renderStorageWarning,
} from '../js/view.js';
import { buildTimeline } from '../js/timeline.js';
import { emptyState, addAsset, addItem, logCompletion } from '../js/model.js';

const LONG_AGO = '2024-01-01T00:00:00.000Z';
const NOW = new Date(2026, 5, 15);

function household(){
  const s = emptyState();
  const car = addAsset(s, null, {name: 'Honda', category: 'car', fields: {mileage: 41000}, createdAt: LONG_AGO});
  const home = addAsset(s, null, {name: 'House', category: 'home', createdAt: LONG_AGO});
  const furnace = addAsset(s, home.id, {name: 'Furnace', category: 'appliance', createdAt: LONG_AGO});
  const oil = addItem(s, car.id, {name: 'Oil change', createdAt: LONG_AGO,
    schedule: {type: 'interval', every: 5000, unit: 'miles'}});
  const filter = addItem(s, furnace.id, {name: 'Filter', createdAt: LONG_AGO,
    schedule: {type: 'interval', every: 3, unit: 'months'}});
  return {s, car, home, furnace, oil, filter};
}

const row = (name, due, asset = 'Honda', item = {}) =>
  ({item: {id: 'i1', name, schedule: null, ...item}, asset: {name: asset}, due});

/* ---- escaping ---------------------------------------------------------------------------- */

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml(`quote" apos' amp&`), 'quote&quot; apos&#39; amp&amp;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(0), '0', 'zero is not blank');
});

test('user text is escaped everywhere it is rendered', () => {
  const html = renderRow(row('<img src=x onerror=alert(1)>', {state: 'overdue', days: -3}, '"><b>'));
  assert.equal(html.includes('<img src=x'), false, 'item name is escaped');
  assert.equal(html.includes('<b>'), false, 'asset name is escaped');
  assert.ok(html.includes('&lt;img'));
});

test('asset names and schedules are escaped in the assets view', () => {
  const s = emptyState();
  const a = addAsset(s, null, {name: '<b>House</b>', category: 'home'});
  addItem(s, a.id, {name: '<i>Filter</i>', schedule: {type: 'interval', every: 3, unit: 'months'}});
  const html = renderAssets(s);
  assert.equal(html.includes('<b>House</b>'), false);
  assert.equal(html.includes('<i>Filter</i>'), false);
  assert.ok(html.includes('&lt;b&gt;House'));
});

/* ---- rows -------------------------------------------------------------------------------- */

test('a row shows the item, its asset and how overdue it is', () => {
  const html = renderRow(row('Gutters', {state: 'overdue', days: -12}, 'House'));
  assert.ok(html.includes('Gutters'));
  assert.ok(html.includes('House'));
  assert.ok(html.includes('12 days overdue'));
  assert.ok(html.includes('-12d'), 'compact marker too');
  assert.ok(html.includes('class="row overdue'), 'state drives styling');
});

test('a date-driven item gets a one-tap Done button', () => {
  const html = renderRow(row('Gutters', {state: 'overdue', days: -12}));
  assert.ok(html.includes('data-done="i1"'));
  assert.equal(html.includes('data-open-log'), false);
});

test('REGRESSION: a mileage item asks for a reading instead of logging blind', () => {
  /* ADR-0009 recorded that "one tap" cannot be literal for mileage items, because completing
     one needs an odometer value. It must not silently log without one. */
  const html = renderRow(row('Oil change', {state: 'due_soon', mileageRemaining: 80}, 'Honda',
    {schedule: {type: 'interval', every: 5000, unit: 'miles'}}));
  assert.ok(html.includes('data-open-log="i1"'), 'opens a reading prompt');
  assert.equal(html.includes('data-done="i1"'), false, 'never a blind one-tap done');
});

test('the reading form opens for the item being logged, prefilled from the odometer', () => {
  const {s, oil} = household();
  const t = buildTimeline(s, {now: NOW});
  const html = renderTimeline(t, oil.id);
  assert.ok(html.includes(`data-log-form="${oil.id}"`), 'form is open for that item');
  assert.ok(html.includes('value="41000"'), 'prefilled with the current reading');
  assert.ok(html.includes('data-cancel-log'), 'and cancellable');
});

test('a completed one-off offers no Done control', () => {
  const html = renderRow(row('Roof quote', {state: 'done'}));
  assert.equal(html.includes('data-done'), false);
  assert.equal(html.includes('data-open-log'), false);
  assert.ok(html.includes('✓'));
});

test('an item that cannot be tracked says why', () => {
  const html = renderRow(row('Oil change', {state: 'unknown', reason: 'Odometer reading needed'}));
  assert.ok(html.includes('Odometer reading needed'), 'the reason is the message');
});

/* ---- buckets and the whole screen -------------------------------------------------------- */

test('a bucket renders its heading, count and rows', () => {
  const html = renderBucket({
    key: 'overdue', label: 'Overdue', tone: 'urgent',
    rows: [row('A', {state: 'overdue', days: -1}), row('B', {state: 'overdue', days: -2})],
  });
  assert.ok(html.includes('Overdue'));
  assert.ok(html.includes('>2</span>'), 'count reflects the rows');
  assert.ok(html.includes('bucket-overdue'));
});

test('the Done bucket is marked collapsed for the view to fold', () => {
  const html = renderBucket({key: 'done', label: 'Done', tone: 'quiet', collapsed: true,
    rows: [row('Old', {state: 'done'})]});
  assert.ok(html.includes('data-collapsed="1"'));
});

test('the full timeline renders buckets in order', () => {
  const {s, oil, filter} = household();
  logCompletion(s, oil.id, {date: '2026-01-01', mileage: 40000});
  logCompletion(s, filter.id, {date: '2025-06-01'});               // long overdue

  const html = renderTimeline(buildTimeline(s, {now: NOW}));
  assert.ok(html.indexOf('Overdue') < html.indexOf('Later'), 'urgent first');
  assert.ok(html.includes('Filter'));
  assert.ok(html.includes('Oil change'));
});

test('nothing pressing produces an All clear header with what is next', () => {
  const {s, oil, filter} = household();
  logCompletion(s, oil.id, {date: '2026-06-01', mileage: 41000});  // 5,000 miles out
  logCompletion(s, filter.id, {date: '2026-06-10'});               // 3 months out

  const t = buildTimeline(s, {now: NOW});
  assert.equal(t.needsAttention, 0);
  const html = renderTimeline(t);
  assert.ok(html.includes('All clear'));
  assert.ok(html.includes('Next up:'));
  assert.ok(html.includes('Filter'), 'names the soonest item');
});

test('a pressing item suppresses the All clear header', () => {
  const {s, filter} = household();
  logCompletion(s, filter.id, {date: '2025-01-01'});
  const html = renderTimeline(buildTimeline(s, {now: NOW}));
  assert.equal(html.includes('All clear'), false);
});

test('a brand new install is told what to do', () => {
  const html = renderTimeline(buildTimeline(emptyState(), {now: NOW}));
  assert.ok(html.includes('Nothing here yet'));
  assert.ok(html.includes('data-add-asset'));
});

/* ---- assets view ------------------------------------------------------------------------- */

test('assets render nested, with their items', () => {
  const {s} = household();
  const html = renderAssets(s);
  assert.ok(html.includes('Honda'));
  assert.ok(html.includes('House'));
  assert.ok(html.includes('Furnace'), 'nested asset appears');
  assert.ok(html.includes('asset-children'), 'and is nested, not flattened');
  assert.ok(html.includes('Every 3 months'), 'items show their schedule in words');
  assert.ok(html.includes('41,000 mi'), 'a car shows its odometer');
});

test('an empty assets tab offers the same way in', () => {
  assert.ok(renderAssets(emptyState()).includes('data-add-asset'));
});

/* ---- chrome ------------------------------------------------------------------------------ */

test('tabs mark the active one', () => {
  const html = renderTabs('due');
  assert.ok(html.includes('class="tab active" data-tab="due"'));
  assert.ok(html.includes('data-tab="assets"'));
  assert.equal(renderTabs('assets').includes('class="tab active" data-tab="assets"'), true);
});

test('storage trouble is stated plainly and only when real', () => {
  assert.equal(renderStorageWarning('ok'), '');
  assert.match(renderStorageWarning('unavailable'), /not being saved/);
  assert.match(renderStorageWarning('corrupt'), /set aside/);
  assert.ok(renderStorageWarning('unavailable').includes('role="alert"'));
});
