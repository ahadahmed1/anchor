/* Tests for the scheduling engine. Run with `npm test` (or `node --test test/`).
   No dependencies — node's built-in test runner and assert only. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDay, formatDay, daysInMonth, today, daysBetween, compareDay,
  addDays, addMonths, addYears, addUnits,
  latestLogDay, latestLogMileage, nextDue, describe, DEFAULT_LEAD_DAYS,
} from '../js/schedule.js';

/** Local-calendar Date for a given y/m/d, avoiding UTC string parsing. */
const at = (y, m, d) => new Date(y, m - 1, d);
const day = s => parseDay(s);

/* ---- date primitives --------------------------------------------------------------------- */

test('parseDay accepts valid dates and rejects nonsense', () => {
  assert.deepEqual(parseDay('2026-01-31'), {y: 2026, m: 1, d: 31});
  assert.equal(parseDay('2026-02-30'), null, 'Feb 30 is not a date');
  assert.equal(parseDay('2026-13-01'), null, 'month 13');
  assert.equal(parseDay('2026-1-1'), null, 'unpadded');
  assert.equal(parseDay('not a date'), null);
  assert.equal(parseDay(undefined), null);
  assert.deepEqual(parseDay('2024-02-29'), {y: 2024, m: 2, d: 29}, 'leap day is valid');
  assert.equal(parseDay('2026-02-29'), null, '...but not in a common year');
});

test('REGRESSION: parsing a date string never shifts the day', () => {
  /* new Date('2026-01-31') parses as UTC midnight, so in any timezone west of UTC the local
     getters report Jan 30. The old engine ran every date through that path. */
  assert.equal(parseDay('2026-01-31').d, 31);
  assert.equal(formatDay(parseDay('2026-01-31')), '2026-01-31', 'round-trips exactly');
  assert.equal(new Date('2026-01-31').getDate() === 31, false,
    'sanity: the naive path really is broken in this timezone');
});

test('REGRESSION: adding months clamps instead of overflowing', () => {
  assert.equal(formatDay(addMonths(day('2026-01-31'), 1)), '2026-02-28', 'was Mar 3');
  assert.equal(formatDay(addMonths(day('2026-08-31'), 1)), '2026-09-30', 'was Oct 1');
  assert.equal(formatDay(addMonths(day('2024-01-31'), 1)), '2024-02-29', 'leap year');
  assert.equal(formatDay(addYears(day('2024-02-29'), 1)), '2025-02-28', 'was Mar 1');
  assert.equal(formatDay(addMonths(day('2026-01-31'), 3)), '2026-04-30');
  assert.equal(formatDay(addMonths(day('2026-01-15'), 1)), '2026-02-15', 'ordinary case unaffected');
});

test('month arithmetic crosses year boundaries in both directions', () => {
  assert.equal(formatDay(addMonths(day('2026-11-15'), 3)), '2027-02-15');
  assert.equal(formatDay(addMonths(day('2026-02-15'), -3)), '2025-11-15');
  assert.equal(formatDay(addMonths(day('2026-01-15'), -1)), '2025-12-15');
});

test('daysBetween is DST-proof', () => {
  /* US DST changes on 2026-03-08; a naive local-midnight subtraction yields 0.958 days here. */
  assert.equal(daysBetween(day('2026-03-07'), day('2026-03-09')), 2);
  assert.equal(daysBetween(day('2026-11-01'), day('2026-11-02')), 1);
  assert.equal(daysBetween(day('2026-01-01'), day('2027-01-01')), 365);
  assert.equal(daysBetween(day('2026-05-10'), day('2026-05-01')), -9, 'negative when b precedes a');
});

test('addDays and daysInMonth', () => {
  assert.equal(formatDay(addDays(day('2026-02-28'), 1)), '2026-03-01');
  assert.equal(formatDay(addDays(day('2024-02-28'), 1)), '2024-02-29');
  assert.equal(formatDay(addDays(day('2026-01-01'), -1)), '2025-12-31');
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2000, 2), 29, 'divisible by 400');
  assert.equal(daysInMonth(1900, 2), 28, 'divisible by 100 but not 400');
});

test('addUnits dispatches, and rejects unknown units', () => {
  assert.equal(formatDay(addUnits(day('2026-01-01'), 2, 'weeks')), '2026-01-15');
  assert.equal(formatDay(addUnits(day('2026-01-01'), 10, 'days')), '2026-01-11');
  assert.equal(formatDay(addUnits(day('2026-01-01'), 1, 'years')), '2027-01-01');
  assert.equal(addUnits(day('2026-01-01'), 1, 'fortnights'), null);
});

test('today() reads the local calendar', () => {
  assert.deepEqual(today(at(2026, 1, 31)), {y: 2026, m: 1, d: 31});
  assert.equal(compareDay(day('2026-01-01'), day('2026-01-02')) < 0, true);
  assert.equal(compareDay(day('2026-01-02'), day('2026-01-02')), 0);
});

/* ---- log reads --------------------------------------------------------------------------- */

test('log reads do not depend on array order', () => {
  const log = [
    {date: '2026-03-01', mileage: 35000},
    {date: '2026-08-01', mileage: 41000},
    {date: '2026-05-01', mileage: 38000},
  ];
  const shuffled = [log[1], log[2], log[0]];
  for(const l of [log, shuffled, [...log].reverse()]){
    assert.equal(formatDay(latestLogDay(l)), '2026-08-01');
    assert.equal(latestLogMileage(l), 41000);
  }
});

test('latestLogMileage skips entries without mileage', () => {
  const log = [
    {date: '2026-01-01', mileage: 30000},
    {date: '2026-09-01'},                     // logged, no odometer reading
    {date: '2026-06-01', mileage: 36000},
  ];
  assert.equal(latestLogMileage(log), 36000, 'newest entry that actually has mileage');
  assert.equal(formatDay(latestLogDay(log)), '2026-09-01', 'but the newest date is the newest date');
});

test('log reads tolerate junk', () => {
  assert.equal(latestLogDay([]), null);
  assert.equal(latestLogDay(undefined), null);
  assert.equal(latestLogMileage([{date: 'bad', mileage: 5}]), null);
  assert.equal(latestLogMileage([{date: '2026-01-01', mileage: ''}]), null);
  assert.equal(latestLogMileage([{date: '2026-01-01', mileage: 'lots'}]), null);
});

/* ---- once -------------------------------------------------------------------------------- */

test('once: unscheduled, upcoming, overdue, and done', () => {
  const now = at(2026, 6, 15);
  const mk = (date, log) => ({schedule: {type: 'once', date}, log: log || []});

  assert.equal(nextDue(mk(null), {now}).state, 'unknown');
  assert.equal(nextDue(mk(null), {now}).reason, 'No date set');

  assert.equal(nextDue(mk('2026-12-01'), {now}).state, 'upcoming');
  assert.equal(nextDue(mk('2026-06-20'), {now}).state, 'due_soon', 'inside the 14-day lead');
  assert.equal(nextDue(mk('2026-06-15'), {now}).state, 'due_soon', 'due today is not overdue');

  const late = nextDue(mk('2026-06-01'), {now});
  assert.equal(late.state, 'overdue');
  assert.equal(late.days, -14);

  const done = nextDue(mk('2026-06-01', [{date: '2026-06-02'}]), {now});
  assert.equal(done.state, 'done', 'completion is derived from the log, not a stored flag');
});

test('once: leadDays is configurable', () => {
  const now = at(2026, 6, 15);
  const item = {schedule: {type: 'once', date: '2026-07-10'}, log: []};
  assert.equal(nextDue(item, {now}).state, 'upcoming', `25 days out, past the ${DEFAULT_LEAD_DAYS}-day default`);
  assert.equal(nextDue({...item, leadDays: 30}, {now}).state, 'due_soon');
});

/* ---- fixed ------------------------------------------------------------------------------- */

test('REGRESSION: a fixed-date item can be overdue', () => {
  /* The old engine only ever returned the NEXT occurrence, so `days` was always >= 0 and a
     yearly item could never report overdue. */
  const item = {schedule: {type: 'fixed', month: 3, day: 1}, log: [], createdAt: '2024-01-01'};
  const r = nextDue(item, {now: at(2026, 3, 5)});
  assert.equal(r.state, 'overdue');
  assert.equal(r.date, '2026-03-01');
  assert.equal(r.days, -4);
});

test('fixed: logging it rolls the due date to next year', () => {
  const item = {
    schedule: {type: 'fixed', month: 3, day: 1},
    log: [{date: '2026-03-02'}],
    createdAt: '2024-01-01',
  };
  const r = nextDue(item, {now: at(2026, 3, 5)});
  assert.equal(r.date, '2027-03-01');
  assert.equal(r.state, 'upcoming');
});

test('fixed: a newly created item is not overdue for a cycle predating it', () => {
  const item = {schedule: {type: 'fixed', month: 3, day: 1}, log: [], createdAt: '2026-02-20'};
  const r = nextDue(item, {now: at(2026, 2, 20)});
  assert.equal(r.date, '2026-03-01', 'due at the upcoming occurrence, not last March');
  assert.equal(r.state, 'due_soon');
});

test('fixed: an item that has never been done and missed a cycle IS overdue', () => {
  const item = {schedule: {type: 'fixed', month: 3, day: 1}, log: [], createdAt: '2024-01-01'};
  const r = nextDue(item, {now: at(2026, 2, 20)});
  assert.equal(r.date, '2025-03-01');
  assert.equal(r.state, 'overdue');
});

test('fixed: Feb 29 clamps in common years', () => {
  const item = {schedule: {type: 'fixed', month: 2, day: 29}, log: [], createdAt: '2026-01-01'};
  assert.equal(nextDue(item, {now: at(2026, 1, 15)}).date, '2026-02-28');
});

test('fixed: rejects an unset date', () => {
  assert.equal(nextDue({schedule: {type: 'fixed'}, log: []}, {now: at(2026, 1, 1)}).state, 'unknown');
});

/* ---- interval by time -------------------------------------------------------------------- */

test('interval: counts from the most recent log entry', () => {
  const item = {
    schedule: {type: 'interval', every: 3, unit: 'months'},
    log: [{date: '2026-01-10'}, {date: '2026-04-10'}],
    createdAt: '2025-12-01',
  };
  const r = nextDue(item, {now: at(2026, 6, 1)});
  assert.equal(r.date, '2026-07-10', 'April + 3 months, not January + 3');
  assert.equal(r.state, 'upcoming');
});

test('interval: falls back to createdAt when never logged', () => {
  const item = {
    schedule: {type: 'interval', every: 1, unit: 'months'},
    log: [],
    createdAt: '2026-05-01T12:00:00.000Z',
  };
  assert.equal(nextDue(item, {now: at(2026, 5, 15)}).date, '2026-06-01');
});

test('REGRESSION: a month-end interval does not drift', () => {
  /* Logged Jan 31 on a monthly schedule, the old engine produced Mar 3 and drifted further
     with every completion. */
  const item = {
    schedule: {type: 'interval', every: 1, unit: 'months'},
    log: [{date: '2026-01-31'}],
    createdAt: '2026-01-01',
  };
  assert.equal(nextDue(item, {now: at(2026, 2, 1)}).date, '2026-02-28');
});

test('interval: overdue and due_soon', () => {
  const mk = logDate => ({
    schedule: {type: 'interval', every: 3, unit: 'months'},
    log: [{date: logDate}],
    createdAt: '2025-01-01',
  });
  assert.equal(nextDue(mk('2026-01-01'), {now: at(2026, 6, 1)}).state, 'overdue');
  assert.equal(nextDue(mk('2026-03-05'), {now: at(2026, 6, 1)}).state, 'due_soon');
  assert.equal(nextDue(mk('2026-05-01'), {now: at(2026, 6, 1)}).state, 'upcoming');
});

test('interval: rejects a missing or nonsensical interval', () => {
  const now = at(2026, 1, 1);
  assert.equal(nextDue({schedule: {type: 'interval', unit: 'months'}, log: []}, {now}).state, 'unknown');
  assert.equal(nextDue({schedule: {type: 'interval', every: 0, unit: 'months'}, log: []}, {now}).state, 'unknown');
  assert.equal(nextDue({schedule: {type: 'interval', every: -3, unit: 'months'}, log: []}, {now}).state, 'unknown');
  assert.equal(nextDue({schedule: {type: 'interval', every: 3, unit: 'aeons'}, log: []}, {now}).state, 'unknown');
});

/* ---- interval by mileage ----------------------------------------------------------------- */

test('mileage: needs both an odometer reading and a baseline', () => {
  const item = {
    schedule: {type: 'interval', every: 5000, unit: 'miles'},
    log: [{date: '2026-01-01', mileage: 35000}],
  };
  const noOdo = nextDue(item, {now: at(2026, 6, 1)});
  assert.equal(noOdo.state, 'unknown');
  assert.equal(noOdo.reason, 'Odometer reading needed');

  const noBaseline = nextDue({...item, log: [{date: '2026-01-01'}]}, {now: at(2026, 6, 1), mileage: 41000});
  assert.equal(noBaseline.state, 'unknown');
  assert.equal(noBaseline.reason, 'Log this once to start tracking');
});

test('REGRESSION: an unlogged mileage item is not instantly overdue', () => {
  /* The old engine defaulted the baseline to 0, so target = 0 + 5000 and a car with 41,000
     miles was permanently 36,000 miles overdue. */
  const item = {schedule: {type: 'interval', every: 5000, unit: 'miles'}, log: []};
  assert.equal(nextDue(item, {now: at(2026, 6, 1), mileage: 41000}).state, 'unknown');
});

test('mileage: counts from the last logged reading', () => {
  const item = {
    schedule: {type: 'interval', every: 5000, unit: 'miles'},
    log: [{date: '2026-01-01', mileage: 30000}, {date: '2026-05-01', mileage: 40000}],
  };
  const now = at(2026, 6, 1);
  const upcoming = nextDue(item, {now, mileage: 41000});
  assert.equal(upcoming.state, 'upcoming');
  assert.equal(upcoming.mileageRemaining, 4000, 'target 45,000 less current 41,000');

  assert.equal(nextDue(item, {now, mileage: 44600}).state, 'due_soon', 'within 500 (10% of 5,000)');
  assert.equal(nextDue(item, {now, mileage: 46000}).state, 'overdue');
  assert.equal(nextDue(item, {now, mileage: 46000}).mileageRemaining, -1000);
});

test('mileage: the "soon" window has a 100-mile floor for short intervals', () => {
  const item = {
    schedule: {type: 'interval', every: 500, unit: 'miles'},
    log: [{date: '2026-01-01', mileage: 10000}],
  };
  /* Target is 10,500. 10% of 500 is only 50 miles, so the 100-mile floor is what applies and
     "soon" begins at 10,400 rather than 10,450. The middle case is the one that proves it: at
     10,420 there are 80 miles left, which is inside the floor but outside the percentage. */
  const now = at(2026, 2, 1);
  assert.equal(nextDue(item, {now, mileage: 10400}).state, 'due_soon', 'exactly 100 left, inclusive');
  assert.equal(nextDue(item, {now, mileage: 10420}).state, 'due_soon', '80 left: floor applies, 10% would not');
  assert.equal(nextDue(item, {now, mileage: 10399}).state, 'upcoming', '101 left, just outside');
});

/* ---- misc -------------------------------------------------------------------------------- */

test('a missing schedule is unknown, not a crash', () => {
  const now = at(2026, 1, 1);
  assert.equal(nextDue({}, {now}).state, 'unknown');
  assert.equal(nextDue({schedule: null, log: []}, {now}).state, 'unknown');
  assert.equal(nextDue({schedule: {type: 'wat'}, log: []}, {now}).state, 'unknown');
  assert.equal(nextDue({schedule: {type: 'once', date: '2026-01-01'}}, {now}).state, 'due_soon',
    'a missing log array is treated as empty');
});

test('nextDue defaults to the real clock when no now is given', () => {
  const r = nextDue({schedule: {type: 'once', date: '2099-01-01'}, log: []}, {});
  assert.equal(r.state, 'upcoming');
  assert.equal(nextDue({schedule: {type: 'once', date: '2099-01-01'}, log: []}).state, 'upcoming',
    'ctx itself is optional');
});

test('describe renders each schedule in plain language', () => {
  assert.equal(describe({type: 'interval', every: 3, unit: 'months'}), 'Every 3 months');
  assert.equal(describe({type: 'interval', every: 1, unit: 'months'}), 'Every month');
  assert.equal(describe({type: 'interval', every: 1, unit: 'years'}), 'Every year');
  assert.equal(describe({type: 'interval', every: 5000, unit: 'miles'}), 'Every 5,000 miles');
  assert.equal(describe({type: 'fixed', month: 3, day: 1}), 'Every year on Mar 1');
  assert.equal(describe({type: 'once', date: '2026-06-01'}), 'Once, on 2026-06-01');
  assert.equal(describe({type: 'once'}), 'One-off');
  assert.equal(describe(null), 'No schedule');
});
