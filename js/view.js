/* ---- View ----
   Pure functions from state to HTML strings. Nothing here touches the DOM, reads globals, or
   attaches handlers — js/app.js owns all of that. Keeping the boundary here means the markup
   can be tested in node, and the app re-renders by assigning one innerHTML rather than tracking
   which nodes changed.

   Interaction is expressed as data- attributes that app.js delegates on, so no element ever
   needs to be found again after render. */

import { liveAssets, liveItems, liveLog, CATEGORIES, assetMileage } from './model.js';
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
      <div class="row-body">
        <div class="row-text">
          <span class="row-name">${escapeHtml(item.name || 'Untitled')}</span>
          <span class="row-sub">${escapeHtml(asset.name)} · ${escapeHtml(relativeDue(due))}</span>
        </div>
        <span class="row-when ${state}" aria-hidden="true">${escapeHtml(shortDue(due))}</span>
      </div>
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

  return `<li class="asset" data-asset="${escapeHtml(asset.id)}" style="--depth:${depth}">
      <div class="asset-head">
        <span class="asset-name">${escapeHtml(asset.name || 'Untitled')}</span>
        <span class="asset-meta">${escapeHtml(cat.label)}${miles == null ? '' : ' · ' + escapeHtml(miles.toLocaleString()) + ' mi'}</span>
      </div>
      ${items.length ? `<ul class="asset-items">${items.map(renderAssetItem).join('')}</ul>` : ''}
      ${children.length ? `<ul class="asset-children">${children.map(c => renderAssetNode(c, depth + 1)).join('')}</ul>` : ''}
    </li>`;
}

function renderAssetItem(item){
  const logged = liveLog(item).length;
  return `<li class="asset-item" data-item="${escapeHtml(item.id)}">
      <span class="row-name">${escapeHtml(item.name || 'Untitled')}</span>
      <span class="row-sub">${escapeHtml(describe(item.schedule))}${logged ? ` · ${logged} logged` : ''}</span>
    </li>`;
}

export function renderAssets(state){
  const roots = liveAssets(state);
  if(!roots.length) return renderEmpty();
  return `<ul class="assets">${roots.map(a => renderAssetNode(a, 0)).join('')}</ul>
    <button class="btn-primary add-asset" data-add-asset="1">Add an asset</button>`;
}

/* ---- inline forms ------------------------------------------------------------------------ */
/* Everything that would otherwise be a prompt() is page content instead. Native dialogs block
   the event loop and freeze any browser-automation session driving the app, and an inline form
   has room to explain itself. See the knowledge-vault convention "no native dialogs in app UI". */

export function renderAddAsset(parentId){
  const options = Object.entries(CATEGORIES)
    .map(([key, c]) => `<option value="${escapeHtml(key)}">${escapeHtml(c.label)}</option>`).join('');
  return `<form class="card form" data-add-asset-form="${escapeHtml(parentId || '')}">
      <h2 class="form-head">${parentId ? 'Add something inside this' : 'Add an asset'}</h2>
      <label class="field">
        <span>Name</span>
        <input name="name" required autocomplete="off" placeholder="2019 Honda CR-V">
      </label>
      <label class="field">
        <span>Kind</span>
        <select name="category">${options}</select>
      </label>
      <div class="form-actions">
        <button class="btn-primary" type="submit">Add</button>
        <button class="btn-quiet" type="button" data-cancel-form="1">Cancel</button>
      </div>
    </form>`;
}

export const PRESETS = {
  '3-months':  {label: 'Every 3 months', schedule: {type: 'interval', every: 3,  unit: 'months'}},
  'monthly':   {label: 'Every month',    schedule: {type: 'interval', every: 1,  unit: 'months'}},
  '6-months':  {label: 'Every 6 months', schedule: {type: 'interval', every: 6,  unit: 'months'}},
  'yearly':    {label: 'Every year',     schedule: {type: 'interval', every: 1,  unit: 'years'}},
  'miles':     {label: 'Every N miles',  needs: 'miles'},
  'once':      {label: 'One-off, on a date', needs: 'date'},
};

export function renderAddItem(asset, preset = '3-months'){
  const options = Object.entries(PRESETS)
    .map(([key, p]) => `<option value="${key}"${key === preset ? ' selected' : ''}>${escapeHtml(p.label)}</option>`)
    .join('');
  const needs = (PRESETS[preset] || {}).needs;
  const extra = needs === 'miles'
    ? `<label class="field"><span>Miles between</span>
         <input name="every" type="number" inputmode="numeric" value="5000" min="1" required></label>`
    : needs === 'date'
      ? `<label class="field"><span>Date</span><input name="date" type="date" required></label>`
      : '';

  return `<form class="card form" data-add-item-form="${escapeHtml(asset.id)}">
      <h2 class="form-head">Add to ${escapeHtml(asset.name)}</h2>
      <label class="field">
        <span>What</span>
        <input name="name" required autocomplete="off" placeholder="Oil change">
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
export function scheduleFromForm(preset, values){
  const p = PRESETS[preset];
  if(!p) return null;
  if(p.schedule) return {...p.schedule};
  if(p.needs === 'miles'){
    const every = Number(values.every);
    return Number.isFinite(every) && every > 0 ? {type: 'interval', every, unit: 'miles'} : null;
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
