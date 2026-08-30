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

/* ---- item detail ------------------------------------------------------------------------- */

import { renderItemDetail, editableField } from '../js/view.js';
import { nextDue } from '../js/schedule.js';
import { findItem, liveLog, assetMileage, deleteEntry } from '../js/model.js';

/** Resolve an item the way app.js does before handing it to the detail view. */
function detailRow(s, id, now = NOW){
  const hit = findItem(s, id);
  return {...hit, due: nextDue({...hit.item, log: liveLog(hit.item)},
    {now, mileage: assetMileage(hit.asset)})};
}

test('editableField is text until it is the field being edited', () => {
  const read = editableField('name:i1', 'Oil change', {editing: null});
  assert.ok(read.includes('data-edit="name:i1"'), 'clicking it starts an edit');
  assert.equal(read.includes('<input'), false, 'no input while reading');

  const write = editableField('name:i1', 'Oil change', {editing: 'name:i1'});
  assert.ok(write.includes('data-field="name:i1"'));
  assert.ok(write.includes('value="Oil change"'),
    'rendered as an attribute so defaultValue holds the original for Escape');
});

test('editableField shows a placeholder when empty, and escapes both', () => {
  const empty = editableField('notes:i1', '', {editing: null, placeholder: 'Add a note…'});
  assert.ok(empty.includes('Add a note…'));
  assert.ok(empty.includes('is-empty'));
  assert.equal(editableField('n:1', '<b>x</b>', {editing: null}).includes('<b>'), false);
});

test('a multiline field renders a textarea carrying its value as content', () => {
  const html = editableField('notes:i1', 'line one', {editing: 'notes:i1', multiline: true});
  assert.ok(html.includes('<textarea'));
  assert.ok(html.includes('>line one</textarea>'), 'defaultValue comes from the content');
});

test('detail shows the item, its asset, due state and schedule in words', () => {
  const {s, filter} = household();
  logCompletion(s, filter.id, {date: '2026-05-01'});
  const html = renderItemDetail(detailRow(s, filter.id));

  assert.ok(html.includes('Furnace filter') || html.includes('Filter'));
  assert.ok(html.includes('Furnace'), 'names the owning asset');
  assert.ok(html.includes('Every 3 months'), 'schedule in plain language');
  assert.ok(html.includes('data-back'), 'there is a way back');
  assert.ok(html.includes('data-delete-item="' + filter.id + '"'));
});

test('detail lists history newest first, each entry removable', () => {
  const {s, filter} = household();
  logCompletion(s, filter.id, {date: '2026-01-10', note: 'first'});
  logCompletion(s, filter.id, {date: '2026-05-01', note: 'second', cost: '18'});

  const html = renderItemDetail(detailRow(s, filter.id));
  assert.ok(html.indexOf('2026-05-01') < html.indexOf('2026-01-10'), 'newest first');
  assert.ok(html.includes('18'), 'cost shown');
  assert.ok(html.includes('data-delete-entry'));
  assert.ok(html.includes('>2</span>'), 'history is counted');
});

test('detail hides tombstoned log entries', () => {
  const {s, filter} = household();
  const gone = logCompletion(s, filter.id, {date: '2026-09-09', note: 'mistake'});
  logCompletion(s, filter.id, {date: '2026-05-01'});
  deleteEntry(s, filter.id, gone.id);

  const html = renderItemDetail(detailRow(s, filter.id));
  assert.equal(html.includes('2026-09-09'), false);
  assert.equal(html.includes('mistake'), false);
  assert.ok(html.includes('2026-05-01'));
});

test('detail says so when nothing has been logged', () => {
  const {s, filter} = household();
  assert.ok(renderItemDetail(detailRow(s, filter.id)).includes('Nothing logged yet'));
});

test('REGRESSION: detail keeps the mileage prompt rather than a blind Mark done', () => {
  const {s, oil} = household();
  const closed = renderItemDetail(detailRow(s, oil.id), {});
  assert.ok(closed.includes('data-open-log="' + oil.id + '"'));
  assert.equal(closed.includes('data-done='), false);

  const open = renderItemDetail(detailRow(s, oil.id), {openLogId: oil.id});
  assert.ok(open.includes('data-log-form="' + oil.id + '"'));
  assert.ok(open.includes('value="41000"'), 'prefilled from the asset odometer');
});

test('a date-driven item gets a plain Mark done today', () => {
  const {s, filter} = household();
  const html = renderItemDetail(detailRow(s, filter.id), {});
  assert.ok(html.includes('data-done="' + filter.id + '"'));
  assert.ok(html.includes('Mark done today'));
});

test('timeline rows and asset items both open the detail page', () => {
  const {s, filter} = household();
  const timeline = renderTimeline(buildTimeline(s, {now: NOW}));
  assert.ok(timeline.includes('data-open-item="' + filter.id + '"'));
  assert.ok(renderAssets(s).includes('data-open-item="' + filter.id + '"'));
});

/* ---- schedule editor --------------------------------------------------------------------- */

import { renderScheduleEditor, presetForSchedule } from '../js/view.js';
import { scheduleFromForm as fromForm } from '../js/view.js';

test('presetForSchedule recognises what an item is already on', () => {
  assert.equal(presetForSchedule({type: 'interval', every: 3, unit: 'months'}), '3-months');
  assert.equal(presetForSchedule({type: 'interval', every: 1, unit: 'months'}), 'monthly');
  assert.equal(presetForSchedule({type: 'interval', every: 1, unit: 'years'}), 'yearly');
  assert.equal(presetForSchedule({type: 'interval', every: 5000, unit: 'miles'}), 'miles');
  assert.equal(presetForSchedule({type: 'once', date: '2026-06-01'}), 'once');
  assert.equal(presetForSchedule({type: 'interval', every: 2, unit: 'weeks'}), '',
    'a schedule no preset covers matches none');
  assert.equal(presetForSchedule(null), '');
});

test('a fixed preset needs no second step', () => {
  const html = renderScheduleEditor({id: 'i1', schedule: {type: 'interval', every: 3, unit: 'months'}}, null);
  assert.ok(html.includes('data-schedule-select="i1"'));
  assert.equal(html.includes('<form'), false, 'commits on choice, nothing to submit');
  assert.ok(html.includes('value="3-months" selected'), 'opens on what it already is');
});

test('REGRESSION: choosing miles opens a field instead of doing nothing', () => {
  const html = renderScheduleEditor({id: 'i1', schedule: {type: 'interval', every: 3, unit: 'months'}}, 'miles');
  assert.ok(html.includes('data-schedule-form="i1"'), 'drops into a sub-view');
  assert.ok(html.includes('name="every"'));
  assert.ok(html.includes('value="5000"'), 'sensible default when switching in');
  assert.ok(html.includes('name="preset" value="miles"'), 'the choice travels with the form');
});

test('REGRESSION: choosing one-off opens a date field', () => {
  const html = renderScheduleEditor({id: 'i1', schedule: null}, 'once');
  assert.ok(html.includes('data-schedule-form="i1"'));
  assert.ok(html.includes('type="date"'));
  assert.ok(html.includes('name="preset" value="once"'));
});

test('an existing miles schedule prefills its own value, not the default', () => {
  const html = renderScheduleEditor({id: 'i1', schedule: {type: 'interval', every: 7500, unit: 'miles'}}, null);
  assert.ok(html.includes('value="7500"'), 'shows what it is, not 5000');
  assert.ok(html.includes('value="miles" selected'));
});

test('an existing one-off prefills its date', () => {
  const html = renderScheduleEditor({id: 'i1', schedule: {type: 'once', date: '2026-06-01'}}, null);
  assert.ok(html.includes('value="2026-06-01"'));
});

test('a schedule no preset covers keeps a place in the list', () => {
  const html = renderScheduleEditor({id: 'i1', schedule: {type: 'interval', every: 2, unit: 'weeks'}}, null);
  assert.ok(html.includes('Every 2 weeks'), 'described in the options');
  assert.ok(html.includes('<option value="" selected'), 'and selected, so opening cannot discard it');
});

test('the editor round-trips through scheduleFromForm', () => {
  assert.deepEqual(fromForm('miles', {every: '7500'}), {type: 'interval', every: 7500, unit: 'miles'});
  assert.deepEqual(fromForm('once', {date: '2026-06-01'}), {type: 'once', date: '2026-06-01'});
  assert.deepEqual(fromForm('3-months', {}), {type: 'interval', every: 3, unit: 'months'});
  assert.equal(fromForm('miles', {every: '0'}), null, 'refuses a nonsense interval');
  assert.equal(fromForm('once', {date: ''}), null, 'refuses a missing date');
});

test('the detail page uses the editor when the schedule is being edited', () => {
  const {s, filter} = household();
  const row = detailRow(s, filter.id);
  assert.ok(renderItemDetail(row, {}).includes('data-edit="schedule:' + filter.id + '"'),
    'reads as text until clicked');
  const editing = renderItemDetail(row, {editing: 'schedule:' + filter.id, schedulePreset: 'miles'});
  assert.ok(editing.includes('data-schedule-form="' + filter.id + '"'));
});
