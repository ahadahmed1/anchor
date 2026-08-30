/* ---- View ----
   Pure functions from state to HTML strings. Nothing here touches the DOM, reads globals, or
   attaches handlers — js/app.js owns all of that. Keeping the boundary here means the markup
   can be tested in node, and the app re-renders by assigning one innerHTML rather than tracking
   which nodes changed.

   Interaction is expressed as data- attributes that app.js delegates on, so no element ever
   needs to be found again after render. */

import { liveAssets, liveItems, liveLog, CATEGORIES, CATEGORY_ORDER, assetMileage, countWithin } from './model.js';
import { relativeDue, shortDue } from './timeline.js';
import { describe } from './schedule.js';

export function escapeHtml(value){
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---- timeline ---------------------------------------------------------------------------- */

/** A mileage item cannot be completed with one tap: it needs the odometer. See ADR-0009. */
function needsReading(row){
  const s = row.item.schedule;
  return !!(s && s.type === 'interval' && s.unit === 'miles');
}

function doneControl(row, openId){
  const id = escapeHtml(row.item.id);
  if(row.due && row.due.state === 'done') return '';

  if(needsReading(row)){
    if(openId === row.item.id){
      const current = assetMileage(row.asset);
      return `<form class="reading" data-log-form="${id}">
          <input class="reading-input" type="number" inputmode="numeric" name="mileage"
                 value="${current == null ? '' : escapeHtml(current)}"
                 aria-label="Odometer reading" required>
          <button class="btn-primary" type="submit">Log</button>
          <button class="btn-quiet" type="button" data-cancel-log="1">Cancel</button>
        </form>`;
    }
    return `<button class="btn-done" data-open-log="${id}">Done…</button>`;
  }
  return `<button class="btn-done" data-done="${id}">Done</button>`;
}

export function renderRow(row, openId){
  const {item, asset, due} = row;
  const state = escapeHtml((due && due.state) || 'unknown');
  const open = openId === item.id;
  return `<li class="row ${state}${open ? ' row-open' : ''}" data-item="${escapeHtml(item.id)}">
      <button class="row-body" data-open-item="${escapeHtml(item.id)}">
        <span class="row-text">
          <span class="row-name">${escapeHtml(item.name || 'Untitled')}</span>
          <span class="row-sub">${escapeHtml(asset.name)} · ${escapeHtml(relativeDue(due))}</span>
        </span>
        <span class="row-when ${state}" aria-hidden="true">${escapeHtml(shortDue(due))}</span>
      </button>
      ${doneControl(row, openId)}
    </li>`;
}

export function renderBucket(bucket, openId){
  return `<section class="bucket bucket-${escapeHtml(bucket.key)} tone-${escapeHtml(bucket.tone)}"${bucket.collapsed ? ' data-collapsed="1"' : ''}>
      <h2 class="bucket-head">
        ${escapeHtml(bucket.label)}
        <span class="bucket-count">${bucket.rows.length}</span>
      </h2>
      <ul class="rows">${bucket.rows.map(r => renderRow(r, openId)).join('')}</ul>
    </section>`;
}

/** The screen a well-maintained household sees most of the time. */
export function renderAllClear(timeline){
  const next = timeline.nextUp;
  const line = next
    ? `Next up: ${escapeHtml(next.item.name)} ${escapeHtml(relativeDue(next.due))}`
    : 'Nothing scheduled yet.';
  return `<div class="allclear">
      <p class="allclear-mark">All clear</p>
      <p class="allclear-next">${line}</p>
    </div>`;
}

export function renderEmpty(){
  return `<div class="empty">
      <p class="empty-title">Nothing here yet</p>
      <p class="empty-sub">Add something you look after — a car, the house, an appliance.</p>
      <button class="btn-primary" data-add-asset="1">Add an asset</button>
    </div>`;
}

export function renderTimeline(timeline, openId){
  if(timeline.total === 0) return renderEmpty();

  /* The attention buckets are what the app is for, so when they are empty that fact is stated
     rather than left for the reader to infer from an absence. */
  const head = timeline.needsAttention === 0 ? renderAllClear(timeline) : '';
  return head + timeline.buckets.map(b => renderBucket(b, openId)).join('');
}

/* ---- assets ------------------------------------------------------------------------------ */

function renderAssetNode(asset, depth){
  const items = liveItems(asset);
  const children = liveAssets(asset);
  const cat = CATEGORIES[asset.category] || CATEGORIES.other;
  const miles = assetMileage(asset);

  return `<li class="asset" style="--depth:${depth}">
      <button class="asset-head" data-open-asset="${escapeHtml(asset.id)}">
        <span class="asset-name">${escapeHtml(asset.name || 'Untitled')}</span>
        <span class="asset-meta">${escapeHtml(cat.label)}${miles == null ? '' : ' · ' + escapeHtml(miles.toLocaleString()) + ' mi'}</span>
      </button>
      ${items.length ? `<ul class="asset-items">${items.map(renderAssetItem).join('')}</ul>` : ''}
      ${children.length ? `<ul class="asset-children">${children.map(c => renderAssetNode(c, depth + 1)).join('')}</ul>` : ''}
    </li>`;
}

function renderAssetItem(item){
  const logged = liveLog(item).length;
  return `<li class="asset-item">
      <button class="asset-item-body" data-open-item="${escapeHtml(item.id)}">
        <span class="row-name">${escapeHtml(item.name || 'Untitled')}</span>
        <span class="row-sub">${escapeHtml(describe(item.schedule))}${logged ? ` · ${logged} logged` : ''}</span>
      </button>
    </li>`;
}

export function renderAssets(state){
  const roots = liveAssets(state);
  if(!roots.length) return renderEmpty();
  return `<ul class="assets">${roots.map(a => renderAssetNode(a, 0)).join('')}</ul>
    <button class="btn-primary add-asset" data-add-asset="1">Add an asset</button>`;
}

/* ---- item detail ------------------------------------------------------------------------- */
/* Read-first: fields are text until clicked, one editable at a time. Carried over as a
   principle from ADR-0003 — these screens are opened far more often to check something than
   to change it, so they should read as a record rather than a form. */

/**
 * A field that displays as text and becomes an input when it is the one being edited.
 * `key` is what app.js matches on; it is both the edit trigger and the input identity.
 */
export function editableField(key, value, {editing, placeholder = 'Add…', multiline = false} = {}){
  const k = escapeHtml(key);
  if(editing === key){
    /* value= rather than a text node so the browser records it as defaultValue: Escape restores
       from there before the input leaves the DOM. Removing a focused input fires a native blur,
       which would otherwise commit the very edit being discarded. See ADR-0003. */
    return multiline
      ? `<textarea class="edit-input" data-field="${k}" rows="4">${escapeHtml(value)}</textarea>`
      : `<input class="edit-input" data-field="${k}" value="${escapeHtml(value)}">`;
  }
  const shown = value == null || value === '' ? placeholder : value;
  const empty = value == null || value === '' ? ' is-empty' : '';
  return `<span class="editable${empty}" data-edit="${k}" tabindex="0" role="button">${escapeHtml(shown)}</span>`;
}

function renderLogEntry(entry){
  const bits = [];
  if(entry.mileage != null) bits.push(`${entry.mileage.toLocaleString()} mi`);
  if(entry.cost) bits.push(escapeHtml(entry.cost));
  if(entry.by) bits.push(escapeHtml(entry.by));
  if(entry.note) bits.push(escapeHtml(entry.note));
  return `<li class="log-entry" data-entry="${escapeHtml(entry.id)}">
      <div class="log-text">
        <span class="log-date">${escapeHtml(entry.date)}</span>
        ${bits.length ? `<span class="log-meta">${bits.join(' · ')}</span>` : ''}
      </div>
      <button class="btn-quiet btn-small" data-delete-entry="${escapeHtml(entry.id)}"
              aria-label="Remove this entry">Remove</button>
    </li>`;
}

/**
 * Which preset an existing schedule corresponds to, or '' when it matches none.
 * Exact matches win, so "every 3 months" reads as the named preset rather than as a custom
 * value; anything else on a unit that has a custom option falls back to that.
 */
export function presetForSchedule(schedule){
  if(!schedule) return '';
  if(schedule.type === 'once') return 'once';
  if(schedule.type !== 'interval') return '';

  for(const [key, p] of Object.entries(PRESETS)){
    if(p.schedule && p.schedule.unit === schedule.unit && p.schedule.every === Number(schedule.every)) return key;
  }
  for(const [key, p] of Object.entries(PRESETS)){
    if(p.needs === 'count' && p.unit === schedule.unit) return key;
  }
  return '';
}

/**
 * The schedule editor, shaped after ADR-0003's recurrence popover: presets commit on choice,
 * and the two that carry a value drop into a sub-view with the relevant field rather than
 * being silently unavailable.
 */
export function renderScheduleEditor(item, preset, asset){
  const current = presetForSchedule(item.schedule);
  const chosen = preset == null ? current : preset;
  const needs = (PRESETS[chosen] || {}).needs;

  /* Same filtering as the add form: no mileage schedule for something with no odometer — but
     an item already on one keeps the option, or opening the editor would offer no way back to
     what it currently is. */
  const cat = CATEGORIES[(asset && asset.category)] || CATEGORIES.other;
  const available = Object.entries(PRESETS)
    .filter(([key]) => key !== 'miles' || cat.tracksMileage || current === 'miles');

  /* An item on a schedule no preset covers keeps a home in the list, so opening the editor
     cannot quietly discard it. */
  const keep = current === ''
    ? `<option value=""${chosen === '' ? ' selected' : ''}>${escapeHtml(describe(item.schedule))}</option>`
    : '';
  const options = keep + available
    .map(([key, p]) => `<option value="${key}"${key === chosen ? ' selected' : ''}>${escapeHtml(p.label)}</option>`)
    .join('');

  const select = `<select class="edit-input" data-schedule-select="${escapeHtml(item.id)}">${options}</select>`;
  if(!needs) return select;

  /* Prefill from the item only when the chosen preset is still what it is on, so switching
     "every 2 weeks" to "every N months" offers that preset's default rather than carrying 2
     across into a different unit. */
  const sched = item.schedule || {};
  const keepsValue = chosen === current;
  const field = presetField(chosen, needs === 'date'
    ? (keepsValue ? sched.date : null)
    : (keepsValue ? sched.every : null));

  return `<form class="schedule-editor" data-schedule-form="${escapeHtml(item.id)}">
      ${select}
      <input type="hidden" name="preset" value="${escapeHtml(chosen)}">
      ${field}
      <div class="form-actions">
        <button class="btn-primary" type="submit">Save</button>
        <button class="btn-quiet" type="button" data-cancel-form="1">Cancel</button>
      </div>
    </form>`;
}

export function renderItemDetail(row, ui = {}){
  const {item, asset, due} = row;
  const state = escapeHtml((due && due.state) || 'unknown');
  const entries = liveLog(item)
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return `<article class="detail">
      <button class="btn-quiet back" data-back="1">‹ Back</button>

      <h1 class="detail-name">${editableField(`name:${item.id}`, item.name, {editing: ui.editing, placeholder: 'Untitled'})}</h1>
      <p class="detail-asset">${escapeHtml(asset.name)}</p>

      <div class="detail-due ${state}">
        <span class="detail-due-text">${escapeHtml(relativeDue(due))}</span>
        ${due && due.date ? `<span class="detail-due-date">${escapeHtml(due.date)}</span>` : ''}
      </div>

      ${renderDoneAction(row, ui)}

      <section class="detail-block">
        <h2 class="detail-label">Schedule</h2>
        ${ui.editing === `schedule:${item.id}`
          ? renderScheduleEditor(item, ui.schedulePreset, asset)
          : `<span class="editable" data-edit="schedule:${escapeHtml(item.id)}" tabindex="0" role="button">${escapeHtml(describe(item.schedule))}</span>`}
      </section>

      <section class="detail-block">
        <h2 class="detail-label">Notes</h2>
        ${editableField(`notes:${item.id}`, item.notes, {editing: ui.editing, multiline: true, placeholder: 'Add a note…'})}
      </section>

      <section class="detail-block">
        <h2 class="detail-label">History <span class="bucket-count">${entries.length}</span></h2>
        ${entries.length
          ? `<ul class="log">${entries.map(renderLogEntry).join('')}</ul>`
          : `<p class="detail-empty">Nothing logged yet.</p>`}
      </section>

      <button class="btn-danger" data-delete-item="${escapeHtml(item.id)}">Delete this item</button>
    </article>`;
}

/** The completion control, shared in shape with the timeline row but sized for the page. */
function renderDoneAction(row, ui){
  const id = escapeHtml(row.item.id);
  if(needsReading(row)){
    if(ui.openLogId === row.item.id){
      const current = assetMileage(row.asset);
      return `<form class="reading detail-action" data-log-form="${id}">
          <input class="reading-input" type="number" inputmode="numeric" name="mileage"
                 value="${current == null ? '' : escapeHtml(current)}"
                 aria-label="Odometer reading" required>
          <button class="btn-primary" type="submit">Log it</button>
          <button class="btn-quiet" type="button" data-cancel-log="1">Cancel</button>
        </form>`;
    }
    return `<button class="btn-primary detail-action" data-open-log="${id}">Mark done…</button>`;
  }
  return `<button class="btn-primary detail-action" data-done="${id}">Mark done today</button>`;
}

/* ---- asset detail ------------------------------------------------------------------------ */

/** Category as a chip grid rather than a select, per ADR-0003. Commits on tap. */
function renderCategoryChips(asset, editing){
  if(editing !== `acat:${asset.id}`){
    const cat = CATEGORIES[asset.category] || CATEGORIES.other;
    return `<span class="editable" data-edit="acat:${escapeHtml(asset.id)}" tabindex="0" role="button">${escapeHtml(cat.label)}</span>`;
  }
  return `<div class="chips">${CATEGORY_ORDER.map(key => {
    const on = key === asset.category;
    return `<button class="chip${on ? ' on' : ''}" data-set-category="${escapeHtml(asset.id)}|${escapeHtml(key)}">${escapeHtml(CATEGORIES[key].label)}</button>`;
  }).join('')}</div>`;
}

/** The category's own fields — make/plate/odometer, address, provider. */
function renderAssetFields(asset, editing){
  const cat = CATEGORIES[asset.category] || CATEGORIES.other;
  if(!cat.fields.length) return '';
  return `<section class="detail-block">
      <h2 class="detail-label">Details</h2>
      <dl class="fields">${cat.fields.map(f => `
        <dt>${escapeHtml(f.label)}</dt>
        <dd>${editableField(`afield:${asset.id}:${f.key}`, asset.fields[f.key] == null ? '' : String(asset.fields[f.key]), {editing, placeholder: '—'})}</dd>
      `).join('')}</dl>
    </section>`;
}

/** Deleting cascades, so the confirm names what goes with it. See the vault convention on
    never using a native dialog: an inline confirm has room to state the consequence. */
function renderDeleteConfirm(asset, confirming){
  const id = escapeHtml(asset.id);
  if(confirming !== asset.id){
    return `<button class="btn-danger" data-confirm-delete-asset="${id}">Delete ${escapeHtml(asset.name || 'this')}</button>`;
  }
  const {assets, items} = countWithin(asset);
  const parts = [];
  if(items) parts.push(`${items} scheduled ${items === 1 ? 'item' : 'items'}`);
  if(assets) parts.push(`${assets} nested ${assets === 1 ? 'asset' : 'assets'}`);
  const consequence = parts.length
    ? `This also removes ${parts.join(' and ')}, including their history.`
    : 'Nothing else is attached to it.';

  return `<div class="confirm" role="alertdialog" aria-label="Confirm delete">
      <p class="confirm-text"><strong>Delete ${escapeHtml(asset.name || 'this asset')}?</strong> ${escapeHtml(consequence)}</p>
      <div class="form-actions">
        <button class="btn-danger" data-delete-asset="${id}">Delete</button>
        <button class="btn-quiet" data-cancel-form="1">Cancel</button>
      </div>
    </div>`;
}

export function renderAssetDetail(asset, ui = {}){
  const items = liveItems(asset);
  const children = liveAssets(asset);
  const id = escapeHtml(asset.id);

  return `<article class="detail">
      <button class="btn-quiet back" data-back="1">‹ Back</button>

      <h1 class="detail-name">${editableField(`aname:${asset.id}`, asset.name, {editing: ui.editing, placeholder: 'Untitled'})}</h1>
      <p class="detail-asset">${renderCategoryChips(asset, ui.editing)}</p>

      ${renderAssetFields(asset, ui.editing)}

      <section class="detail-block">
        <h2 class="detail-label">Scheduled <span class="bucket-count">${items.length}</span></h2>
        ${items.length
          ? `<ul class="asset-items flat">${items.map(renderAssetItem).join('')}</ul>`
          : `<p class="detail-empty">Nothing scheduled for this yet.</p>`}
        ${ui.addingItemFor === asset.id
          ? renderAddItem(asset, ui.itemPreset)
          : `<button class="btn-quiet" data-add-item="${id}">Add something to do</button>`}
      </section>

      <section class="detail-block">
        <h2 class="detail-label">Inside this <span class="bucket-count">${children.length}</span></h2>
        ${children.length
          ? `<ul class="asset-children flat">${children.map(c => `
              <li class="asset-item"><button class="asset-item-body" data-open-asset="${escapeHtml(c.id)}">
                <span class="row-name">${escapeHtml(c.name || 'Untitled')}</span>
                <span class="row-sub">${escapeHtml((CATEGORIES[c.category] || CATEGORIES.other).label)}</span>
              </button></li>`).join('')}</ul>`
          : ''}
        ${ui.addingAssetUnder === asset.id
          ? renderAddAsset(asset.id, ui.assetCategory)
          : `<button class="btn-quiet" data-add-asset="${id}">Add something inside</button>`}
      </section>

      ${renderDeleteConfirm(asset, ui.confirmingDelete)}
    </article>`;
}

/* ---- inline forms ------------------------------------------------------------------------ */
/* Everything that would otherwise be a prompt() is page content instead. Native dialogs block
   the event loop and freeze any browser-automation session driving the app, and an inline form
   has room to explain itself. See the knowledge-vault convention "no native dialogs in app UI". */

export function renderAddAsset(parentId, category = 'car'){
  const chosen = CATEGORIES[category] ? category : 'car';
  const options = CATEGORY_ORDER
    .map(key => `<option value="${escapeHtml(key)}"${key === chosen ? ' selected' : ''}>${escapeHtml(CATEGORIES[key].label)}</option>`)
    .join('');
  return `<form class="card form" data-add-asset-form="${escapeHtml(parentId || '')}">
      <h2 class="form-head">${parentId ? 'Add something inside this' : 'Add an asset'}</h2>
      <label class="field">
        <span>Kind</span>
        <select name="category" data-category-select="1">${options}</select>
      </label>
      <label class="field">
        <span>Name</span>
        <input name="name" required autocomplete="off"
               placeholder="${escapeHtml(CATEGORIES[chosen].example)}">
      </label>
      <div class="form-actions">
        <button class="btn-primary" type="submit">Add</button>
        <button class="btn-quiet" type="button" data-cancel-form="1">Cancel</button>
      </div>
    </form>`;
}

/**
 * The schedule choices, in ascending order of interval.
 *
 * A preset either carries a complete `schedule` and commits on choice, or declares `needs` and
 * drops into a sub-view for the value it cannot express in a dropdown. `needs:'count'` covers
 * every "every N somethings" case — weeks, months and miles are the same interaction with a
 * different unit and label, so they share one code path rather than three.
 */
export const PRESETS = {
  'weekly':        {label: 'Every week',      schedule: {type: 'interval', every: 1, unit: 'weeks'}},
  'custom-weeks':  {label: 'Every N weeks…',  needs: 'count', unit: 'weeks',
                    countLabel: 'Weeks between',  countDefault: 2},
  'monthly':       {label: 'Every month',     schedule: {type: 'interval', every: 1, unit: 'months'}},
  '3-months':      {label: 'Every 3 months',  schedule: {type: 'interval', every: 3, unit: 'months'}},
  '6-months':      {label: 'Every 6 months',  schedule: {type: 'interval', every: 6, unit: 'months'}},
  'custom-months': {label: 'Every N months…', needs: 'count', unit: 'months',
                    countLabel: 'Months between', countDefault: 4},
  'yearly':        {label: 'Every year',      schedule: {type: 'interval', every: 1, unit: 'years'}},
  'miles':         {label: 'Every N miles…',  needs: 'count', unit: 'miles',
                    countLabel: 'Miles between',  countDefault: 5000},
  'once':          {label: 'One-off, on a date', needs: 'date'},
};

/** The extra field a preset needs, if any. */
function presetField(preset, value){
  const p = PRESETS[preset];
  if(!p || !p.needs) return '';
  if(p.needs === 'date'){
    return `<label class="field"><span>Date</span>
        <input name="date" type="date" required value="${escapeHtml(value == null ? '' : value)}"></label>`;
  }
  const shown = value == null || value === '' ? p.countDefault : value;
  return `<label class="field"><span>${escapeHtml(p.countLabel)}</span>
      <input name="every" type="number" inputmode="numeric" min="1" required
             value="${escapeHtml(shown)}"></label>`;
}

/**
 * The schedule presets that make sense for an asset.
 * "Every N miles" needs an odometer, so it is offered only where the category has one —
 * otherwise it produces an item that can never come due.
 */
export function presetsFor(asset){
  const cat = CATEGORIES[(asset && asset.category)] || CATEGORIES.other;
  return Object.entries(PRESETS).filter(([key]) => key !== 'miles' || cat.tracksMileage);
}

export function renderAddItem(asset, preset = '3-months'){
  const available = presetsFor(asset);
  const chosen = available.some(([k]) => k === preset) ? preset : '3-months';
  const options = available
    .map(([key, p]) => `<option value="${key}"${key === chosen ? ' selected' : ''}>${escapeHtml(p.label)}</option>`)
    .join('');
  const cat = CATEGORIES[asset.category] || CATEGORIES.other;
  const extra = presetField(chosen);

  return `<form class="card form" data-add-item-form="${escapeHtml(asset.id)}">
      <h2 class="form-head">Add to ${escapeHtml(asset.name)}</h2>
      <label class="field">
        <span>What</span>
        <input name="name" required autocomplete="off" placeholder="${escapeHtml(cat.itemExample)}">
      </label>
      <label class="field">
        <span>How often</span>
        <select name="preset" data-preset-select="1">${options}</select>
      </label>
      ${extra}
      <div class="form-actions">
        <button class="btn-primary" type="submit">Add</button>
        <button class="btn-quiet" type="button" data-cancel-form="1">Cancel</button>
      </div>
    </form>`;
}

/** Turn a submitted add-item form into a schedule object. */
export function scheduleFromForm(preset, values = {}){
  const p = PRESETS[preset];
  if(!p) return null;
  if(p.schedule) return {...p.schedule};
  if(p.needs === 'count'){
    const every = Number(values.every);
    return Number.isFinite(every) && every > 0 ? {type: 'interval', every, unit: p.unit} : null;
  }
  if(p.needs === 'date') return values.date ? {type: 'once', date: values.date} : null;
  return null;
}

/* ---- chrome ------------------------------------------------------------------------------ */

export function renderTabs(active){
  const tab = (key, label) =>
    `<button class="tab${active === key ? ' active' : ''}" data-tab="${key}">${label}</button>`;
  return `<nav class="tabs">${tab('due', 'Due')}${tab('assets', 'Assets')}</nav>`;
}

/** A persistent warning, not a toast: it describes a condition, not an event. */
export function renderStorageWarning(status){
  if(status === 'ok') return '';
  const message = status === 'corrupt'
    ? 'Saved data could not be read. A copy was set aside and this session started empty.'
    : 'Changes are not being saved — storage is blocked or full. They will be lost on reload.';
  return `<p class="warning" role="alert">${escapeHtml(message)}</p>`;
}
