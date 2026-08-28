/* ---- Scheduling engine ----
   Answers one question: given an item and today, when is it next due and how urgent is that?

   Deliberately free of the DOM, of storage, and of any app globals, so the same module can run
   in the page and — if push notifications are ever built — inside a Cloudflare Worker computing
   what to notify about. See knowledge-vault ADR-0008.

   Two rules that the previous implementation got wrong, both worth stating up front:

   1. CALENDAR MATH IS DONE ON INTEGERS, NEVER ON `Date`.
      `new Date('2026-01-31')` parses as UTC midnight, so in any timezone west of UTC the local
      getters report the *previous* day — `.getDate()` returns 30. The old engine ran every
      date-only value through `new Date(str)`, shifting every due date a day earlier for anyone
      in the Americas. Here, 'YYYY-MM-DD' is parsed to {y,m,d} integers and stays that way.

   2. ADDING MONTHS CLAMPS TO THE END OF THE TARGET MONTH.
      `d.setMonth(d.getMonth()+1)` on Jan 31 overflows to Mar 3. The old engine did exactly that,
      and the error compounded every time a completion was logged near a month end. Jan 31 + 1
      month is Feb 28 here, and Aug 31 + 1 month is Sep 30. */

/* ---- date-only primitives ---------------------------------------------------------------- */

/** 'YYYY-MM-DD' -> {y,m,d} with m 1-12, or null if unparseable. */
export function parseDay(s){
  if(typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if(!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if(mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return {y, m: mo, d};
}

/** {y,m,d} -> 'YYYY-MM-DD'. */
export function formatDay(day){
  const p = n => String(n).padStart(2, '0');
  return `${day.y}-${p(day.m)}-${p(day.d)}`;
}

export function daysInMonth(y, m){
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function isLeap(y){ return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

/** Today in the *local* calendar, as {y,m,d}. Accepts an injected Date for testing. */
export function today(now){
  const d = now || new Date();
  return {y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate()};
}

/** Days between two {y,m,d}, b - a. Uses UTC internally so DST can never contribute an hour. */
export function daysBetween(a, b){
  const MS = 86400000;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / MS);
}

/** Compare two {y,m,d}: negative if a is earlier. */
export function compareDay(a, b){
  return (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
}

export function addDays(day, n){
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d));
  t.setUTCDate(t.getUTCDate() + n);
  return {y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate()};
}

/** Add months, clamping to the last valid day: Jan 31 + 1 month = Feb 28, not Mar 3. */
export function addMonths(day, n){
  const total = (day.y * 12) + (day.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12 + 12) % 12 + 1;
  return {y, m, d: Math.min(day.d, daysInMonth(y, m))};
}

/** Feb 29 + 1 year clamps to Feb 28, for the same reason. */
export function addYears(day, n){ return addMonths(day, n * 12); }

export function addUnits(day, every, unit){
  switch(unit){
    case 'days':   return addDays(day, every);
    case 'weeks':  return addDays(day, every * 7);
    case 'months': return addMonths(day, every);
    case 'years':  return addYears(day, every);
    default:       return null;
  }
}

/* ---- log reads --------------------------------------------------------------------------- */
/* Both of these are order-independent on purpose. The old `latestLogMileage` returned the first
   array element carrying mileage, which was only correct because an unrelated function 400 lines
   away re-sorted the log newest-first on every insert. A module that a Worker may one day feed
   from elsewhere cannot rely on an invariant it does not itself maintain. */

/** Most recent log entry date as {y,m,d}, or null. Ignores entries with unparseable dates. */
export function latestLogDay(log){
  let best = null;
  for(const entry of log || []){
    const day = parseDay(entry && entry.date);
    if(day && (!best || compareDay(day, best) > 0)) best = day;
  }
  return best;
}

/** Mileage from the most recent entry that recorded one, or null. Ties break on higher mileage. */
export function latestLogMileage(log){
  let bestDay = null, bestMiles = null;
  for(const entry of log || []){
    if(!entry || entry.mileage == null || entry.mileage === '') continue;
    const miles = Number(entry.mileage);
    if(!Number.isFinite(miles)) continue;
    const day = parseDay(entry.date);
    if(!day) continue;
    const cmp = bestDay ? compareDay(day, bestDay) : 1;
    if(cmp > 0 || (cmp === 0 && miles > bestMiles)){ bestDay = day; bestMiles = miles; }
  }
  return bestMiles;
}

/* ---- due calculation --------------------------------------------------------------------- */

export const DEFAULT_LEAD_DAYS = 14;

/** Mileage counterpart of the lead time: "soon" starts within 10% of the interval, min 100 mi. */
function mileageWindow(every){ return Math.max(every * 0.1, 100); }

function state(days, lead){
  if(days < 0) return 'overdue';
  if(days <= lead) return 'due_soon';
  return 'upcoming';
}

/** An `unknown` result. `reason` is user-facing: it explains what is missing. */
function unknown(reason){
  return {state: 'unknown', date: null, days: null, mileageRemaining: null, reason};
}

/**
 * When is this item next due, and how urgent is that?
 *
 * @param item  {schedule, log, createdAt, leadDays?}
 *              schedule is one of
 *                {type:'interval', every, unit:'days'|'weeks'|'months'|'years'|'miles'}
 *                {type:'fixed', month, day}      recurs annually
 *                {type:'once', date}             a one-off; done once logged
 * @param ctx   {now?: Date, mileage?: number}    mileage is the OWNING ASSET's odometer, not the
 *                                                item's — see ADR-0007
 * @returns {state, date, days, mileageRemaining, reason}
 *          state: 'overdue' | 'due_soon' | 'upcoming' | 'done' | 'unknown'
 *          'unknown' means the item cannot be tracked yet and belongs in "Needs setup".
 */
export function nextDue(item, ctx){
  ctx = ctx || {};
  const now = today(ctx.now);
  const sched = item && item.schedule;
  const log = (item && item.log) || [];
  const lead = item && item.leadDays != null ? Number(item.leadDays) : DEFAULT_LEAD_DAYS;

  if(!sched || !sched.type) return unknown('No schedule set');

  /* ---- once: a one-off job, done as soon as anything is logged against it ---- */
  if(sched.type === 'once'){
    /* Completion is derived from the log rather than stored in a `completedAt` field, so there
       is no second source of truth to drift. See ADR-0002. */
    if(log.length > 0){
      return {state: 'done', date: sched.date || null, days: null, mileageRemaining: null, reason: null};
    }
    const due = parseDay(sched.date);
    if(!due) return unknown('No date set');
    const days = daysBetween(now, due);
    return {state: state(days, lead), date: formatDay(due), days, mileageRemaining: null, reason: null};
  }

  /* ---- fixed: the same calendar date every year ---- */
  if(sched.type === 'fixed'){
    const mo = Number(sched.month), dy = Number(sched.day);
    if(!(mo >= 1 && mo <= 12) || !(dy >= 1 && dy <= 31)) return unknown('No date set');

    /* The old engine only ever returned the NEXT occurrence, which meant a fixed item could
       never report as overdue — `days` was always >= 0. What matters is the current cycle: if
       nothing has been logged since the most recent occurrence, that occurrence is still owed. */
    const clamp = y => ({y, m: mo, d: Math.min(dy, daysInMonth(y, mo))});
    const thisYear = clamp(now.y);
    const last = compareDay(thisYear, now) <= 0 ? thisYear : clamp(now.y - 1);
    const next = compareDay(thisYear, now) <= 0 ? clamp(now.y + 1) : thisYear;

    /* An item created after the last occurrence has not missed it, so it is not overdue for a
       cycle that predates its own existence. Without this, adding "Registration, Mar 1" in
       February would immediately report as a year overdue. */
    const logged = latestLogDay(log);
    const created = parseDay((item.createdAt || '').slice(0, 10));
    const settled = (logged && compareDay(logged, last) >= 0) ||
                    (!logged && created && compareDay(created, last) > 0);
    const due = settled ? next : last;
    const days = daysBetween(now, due);
    return {state: state(days, lead), date: formatDay(due), days, mileageRemaining: null, reason: null};
  }

  if(sched.type !== 'interval') return unknown('Unrecognised schedule');

  const every = Number(sched.every);
  if(!Number.isFinite(every) || every <= 0) return unknown('No interval set');

  /* ---- interval by mileage ---- */
  if(sched.unit === 'miles'){
    const current = ctx.mileage;
    if(current == null || current === '' || !Number.isFinite(Number(current))){
      return unknown('Odometer reading needed');
    }
    const base = latestLogMileage(log);
    /* No logged mileage means there is no baseline to count from. The old engine defaulted the
       baseline to 0, which made a car with 41,000 miles instantly and permanently overdue. */
    if(base == null) return unknown('Log this once to start tracking');

    const target = base + every;
    const remaining = target - Number(current);
    const soonWindow = mileageWindow(every);
    const s = remaining < 0 ? 'overdue' : remaining <= soonWindow ? 'due_soon' : 'upcoming';
    return {state: s, date: null, days: null, mileageRemaining: remaining, reason: null};
  }

  /* ---- interval by time ---- */
  const base = latestLogDay(log) || parseDay((item.createdAt || '').slice(0, 10)) || now;
  const due = addUnits(base, every, sched.unit);
  if(!due) return unknown('Unrecognised interval unit');
  const days = daysBetween(now, due);
  return {state: state(days, lead), date: formatDay(due), days, mileageRemaining: null, reason: null};
}

/* ---- description ------------------------------------------------------------------------- */

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

/** Plain-language rendering of a schedule: "Every 3 months", "Every year on Mar 1". */
export function describe(sched){
  if(!sched || !sched.type) return 'No schedule';
  if(sched.type === 'once') return sched.date ? `Once, on ${sched.date}` : 'One-off';
  if(sched.type === 'fixed'){
    const mo = Number(sched.month);
    if(!(mo >= 1 && mo <= 12)) return 'Yearly';
    return `Every year on ${MONTHS[mo - 1].slice(0, 3)} ${Number(sched.day)}`;
  }
  const every = Number(sched.every);
  if(!Number.isFinite(every) || every <= 0) return 'No interval set';
  if(sched.unit === 'miles') return `Every ${every.toLocaleString()} miles`;
  const unit = every === 1 ? String(sched.unit || '').replace(/s$/, '') : sched.unit;
  return every === 1 ? `Every ${unit}` : `Every ${every} ${unit}`;
}
