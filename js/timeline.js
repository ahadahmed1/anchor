/* ---- Timeline ----
   Turns the flat list of {item, asset, due} rows from the model into the ordered, bucketed
   list that the home screen renders. See ADR-0009.

   ONE NOTE ON THE BUCKET BOUNDARIES. ADR-0009 sketched them as "This week / This month", and
   recorded the risk that those thresholds would drift apart from each item's reminder lead
   time. They are therefore not defined here at all: the first two buckets are the scheduling
   engine's own `overdue` and `due_soon` states, so an item's lead time IS the boundary, and
   there is no second threshold to disagree with it. That also makes the buckets meaningful for
   mileage-based items, which have a due state but no due date and so cannot be sorted into a
   calendar week at all.

   "Needs setup" collects items the engine reported as `unknown` — a mileage rule on a car with
   no odometer reading, a one-off with no date. Without a bucket of their own these would sort
   to the bottom and quietly never be dealt with, and the app would be failing to say that it
   cannot track something. */

import { dueForAll } from './model.js';

/** Rendering order. `collapsed` marks buckets a view may fold away by default. */
export const BUCKETS = [
  {key: 'overdue',     label: 'Overdue',     tone: 'urgent'},
  {key: 'due_soon',    label: 'Due soon',    tone: 'warn'},
  {key: 'this_month',  label: 'This month',  tone: 'normal'},
  {key: 'later',       label: 'Later',       tone: 'quiet'},
  {key: 'needs_setup', label: 'Needs setup', tone: 'quiet'},
  {key: 'done',        label: 'Done',        tone: 'quiet', collapsed: true},
];

export const BUCKET_KEYS = BUCKETS.map(b => b.key);

/** Days beyond the due-soon window that still counts as "this month". */
const MONTH_HORIZON = 31;

/** Which bucket a resolved due state belongs in. */
export function bucketFor(due){
  if(!due) return 'needs_setup';
  switch(due.state){
    case 'unknown':  return 'needs_setup';
    case 'done':     return 'done';
    case 'overdue':  return 'overdue';
    case 'due_soon': return 'due_soon';
    default:
      /* Mileage items have no date, so they cannot be placed on a calendar. They sit in
         Later until the engine promotes them to due_soon on the odometer reading. */
      if(due.days == null) return 'later';
      return due.days <= MONTH_HORIZON ? 'this_month' : 'later';
  }
}

/**
 * Sort key within a bucket: most urgent first.
 * Date-driven items sort by days remaining; mileage items by miles remaining. The two are not
 * comparable, so date items come first and mileage items follow, each internally ordered.
 */
function urgency(row){
  const d = row.due || {};
  if(d.days != null) return [0, d.days];
  if(d.mileageRemaining != null) return [1, d.mileageRemaining];
  return [2, 0];
}

function byUrgencyThenName(a, b){
  const [ga, va] = urgency(a);
  const [gb, vb] = urgency(b);
  if(ga !== gb) return ga - gb;
  if(va !== vb) return va - vb;
  return String(a.item.name).localeCompare(String(b.item.name));
}

/**
 * Group resolved rows into ordered buckets.
 * @param rows [{item, asset, due}]
 * @returns [{key, label, tone, collapsed, rows}] — only buckets that have something in them
 */
export function groupIntoBuckets(rows){
  const byKey = new Map(BUCKET_KEYS.map(k => [k, []]));
  for(const row of rows || []) byKey.get(bucketFor(row.due)).push(row);

  return BUCKETS
    .map(b => ({...b, rows: byKey.get(b.key).sort(byUrgencyThenName)}))
    .filter(b => b.rows.length > 0);
}

/**
 * The whole home screen in one call.
 *
 * `nextUp` is the soonest thing that is not already demanding attention — it exists so an
 * empty screen can say "nothing due, next up in 3 weeks" rather than being a dead end, which
 * is the state a well-maintained household is in most of the time.
 *
 * @returns {buckets, counts, needsAttention, nextUp, total}
 */
export function buildTimeline(state, ctx = {}){
  const rows = dueForAll(state, ctx);
  const buckets = groupIntoBuckets(rows);
  const counts = Object.fromEntries(BUCKET_KEYS.map(k => [k, 0]));
  for(const b of buckets) counts[b.key] = b.rows.length;

  const upcoming = buckets.find(b => b.key === 'this_month') || buckets.find(b => b.key === 'later');
  return {
    buckets,
    counts,
    total: rows.length,
    needsAttention: counts.overdue + counts.due_soon,
    nextUp: upcoming ? upcoming.rows[0] : null,
  };
}

/* ---- presentation helpers ---------------------------------------------------------------- */
/* Kept here rather than in the view because they are pure, worth testing, and describe the
   timeline's own vocabulary. */

/** "12 days overdue", "in 3 days", "today", "in 4,000 miles". */
export function relativeDue(due){
  if(!due) return '';
  if(due.state === 'done') return 'done';
  if(due.state === 'unknown') return due.reason || 'needs setup';

  if(due.days != null){
    const d = due.days;
    if(d === 0) return 'today';
    if(d === 1) return 'tomorrow';
    if(d === -1) return '1 day overdue';
    if(d < 0) return `${-d} days overdue`;
    if(d < 14) return `in ${d} days`;
    if(d < 60) return `in ${Math.round(d / 7)} weeks`;
    return `in ${Math.round(d / 30)} months`;
  }
  if(due.mileageRemaining != null){
    const m = due.mileageRemaining;
    return m < 0
      ? `${Math.abs(m).toLocaleString()} miles overdue`
      : `in ${m.toLocaleString()} miles`;
  }
  return '';
}

/** Compact form for a list row: "-12d", "3d", "4,000mi". */
export function shortDue(due){
  if(!due) return '';
  if(due.state === 'done') return '✓';
  if(due.state === 'unknown') return '—';
  if(due.days != null) return `${due.days}d`;
  if(due.mileageRemaining != null) return `${due.mileageRemaining.toLocaleString()}mi`;
  return '';
}
