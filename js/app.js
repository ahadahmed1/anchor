/* ---- App ----
   The only file that touches the DOM. Everything it renders comes from js/view.js as a string,
   so a change means recomputing one innerHTML rather than tracking which nodes moved. At this
   size that is simpler than diffing and impossible to get subtly wrong.

   All interaction is delegated from two roots, so nothing needs re-binding after a render. */

import { loadState, saveState, loadTheme, saveTheme } from './persist.js';
import {
  addAsset, addItem, logCompletion, findAsset, findItem,
  updateItem, deleteItem, deleteEntry, liveLog, assetMileage,
} from './model.js';
import { buildTimeline } from './timeline.js';
import { nextDue } from './schedule.js';
import {
  renderTimeline, renderAssets, renderTabs, renderStorageWarning,
  renderAddAsset, renderAddItem, renderItemDetail, scheduleFromForm, PRESETS,
} from './view.js';

const appEl = document.getElementById('app');
const chromeEl = document.getElementById('chrome');

let state;
let storageStatus = 'ok';

/* View-only state. Nothing here is persisted: it describes what is open on screen, not data. */
const ui = {
  tab: 'due',
  itemId: null,                 // set when viewing an item's detail page
  editing: null,                // the single field currently editable, per ADR-0003
  schedulePreset: null,         // null = whatever the item already is; else the chosen preset
  openLogId: null,              // mileage item awaiting an odometer reading
  addingAssetUnder: undefined,  // undefined = closed; null = top level; id = nested
  addingItemFor: null,
  itemPreset: '3-months',
};

/* ---- routing ----------------------------------------------------------------------------- */
/* Hash-based, because GitHub Pages will not rewrite unknown paths to index.html and a real
   path would 404 on a deep link. See ADR-0004. */

function readRoute(){
  const hash = location.hash || '';
  const item = /^#\/item\/(.+)$/.exec(hash);
  ui.itemId = item ? decodeURIComponent(item[1]) : null;
  ui.tab = hash === '#/assets' ? 'assets' : 'due';
}
function goto(hash){
  location.hash = hash;
}

/* ---- render ------------------------------------------------------------------------------ */

/** The item being viewed, resolved with its asset and due state, or null if it is gone. */
function currentRow(){
  if(!ui.itemId) return null;
  const hit = findItem(state, ui.itemId);
  if(!hit) return null;
  return {
    ...hit,
    due: nextDue({...hit.item, log: liveLog(hit.item)}, {mileage: assetMileage(hit.asset)}),
  };
}

function render(){
  const row = currentRow();

  /* The detail page is a place, not a panel: it replaces the tabs rather than sitting under
     them, so there is one way back and it is the Back button. */
  chromeEl.innerHTML = row ? '' : renderTabs(ui.tab);

  let html = renderStorageWarning(storageStatus);

  if(row){
    html += renderItemDetail(row, ui);
  } else {
    if(ui.itemId){
      /* Deep link to something deleted or never existing. Say so rather than showing a blank. */
      html += `<p class="warning" role="alert">That item no longer exists.</p>`;
      ui.itemId = null;
    }
    if(ui.addingAssetUnder !== undefined) html += renderAddAsset(ui.addingAssetUnder);
    if(ui.addingItemFor){
      const hit = findAsset(state, ui.addingItemFor);
      if(hit) html += renderAddItem(hit.asset, ui.itemPreset);
    }
    html += ui.tab === 'assets'
      ? renderAssets(state)
      : renderTimeline(buildTimeline(state), ui.openLogId);
  }

  appEl.innerHTML = html;

  const focus = appEl.querySelector('.edit-input, .reading-input, .form input[name="name"]');
  if(focus){
    focus.focus();
    if(focus.select && focus.dataset.field) focus.select();
  }
}

/** Persist, and surface the outcome rather than letting a failed save pass unnoticed. */
function commit(){
  const result = saveState(state);
  if(!result.ok && storageStatus === 'ok') storageStatus = 'unavailable';
  render();
}

function closeForms(){
  ui.openLogId = null;
  ui.editing = null;
  ui.schedulePreset = null;
  ui.addingAssetUnder = undefined;
  ui.addingItemFor = null;
}

/* ---- read-first editing ------------------------------------------------------------------ */
/* One field is editable at a time. Committing on focusout means Escape has to leave the input
   holding its original value before the re-render removes it — removing a focused input fires
   a native blur, and a changed value would then be committed by the very keystroke meant to
   discard it. See ADR-0003, where this cost a bug the first time round. */

function commitField(input){
  const key = input.dataset.field;
  if(!key) return false;
  const [field, id] = key.split(':');
  const value = input.value;
  const hit = findItem(state, id);
  if(!hit) return false;
  if(hit.item[field] === value) return false;   // nothing to save
  updateItem(state, id, {[field]: value});
  return true;
}

/* ---- events ------------------------------------------------------------------------------ */

chromeEl.addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]');
  if(tab){ closeForms(); goto(tab.dataset.tab); }
});

appEl.addEventListener('click', e => {
  const el = sel => e.target.closest(sel);

  const open = el('[data-open-item]');
  if(open){
    closeForms();
    return goto('#/item/' + encodeURIComponent(open.dataset.openItem));
  }

  if(el('[data-back]')){
    closeForms();
    return goto(ui.tab === 'assets' ? '#/assets' : '');
  }

  const edit = el('[data-edit]');
  if(edit){
    ui.editing = edit.dataset.edit;
    /* Open the schedule editor on whatever the item already is, so the current setting is
       preselected and its value prefilled rather than reset to a default. */
    ui.schedulePreset = null;
    return render();
  }

  const delItem = el('[data-delete-item]');
  if(delItem){
    deleteItem(state, delItem.dataset.deleteItem);
    closeForms();
    goto(ui.tab === 'assets' ? '#/assets' : '');
    return commit();
  }

  const delEntry = el('[data-delete-entry]');
  if(delEntry){
    deleteEntry(state, ui.itemId, delEntry.dataset.deleteEntry);
    return commit();
  }

  const done = el('[data-done]');
  if(done){
    logCompletion(state, done.dataset.done, {});
    closeForms();
    return commit();
  }

  const openLog = el('[data-open-log]');
  if(openLog){
    ui.openLogId = openLog.dataset.openLog;
    return render();
  }

  if(el('[data-cancel-log]') || el('[data-cancel-form]')){
    closeForms();
    return render();
  }

  const addAssetBtn = el('[data-add-asset]');
  if(addAssetBtn){
    closeForms();
    ui.addingAssetUnder = null;
    return render();
  }

  /* Tapping an asset in the Assets tab offers to add work to it. */
  const asset = el('[data-asset]');
  if(asset && ui.tab === 'assets'){
    closeForms();
    ui.addingItemFor = asset.dataset.asset;
    ui.itemPreset = '3-months';
    return render();
  }
});

/* Changing the schedule preset re-renders the form so the right extra field appears. */
appEl.addEventListener('change', e => {
  const preset = e.target.closest('[data-preset-select]');
  if(preset){
    ui.itemPreset = preset.value;
    return render();
  }

  /* On the detail page a preset commits straight away — a chip-style choice, not a form to
     submit. Miles and one-off carry a value a select cannot, so those drop into a sub-view
     with the field instead. Shaped after ADR-0003's recurrence popover. */
  const sched = e.target.closest('[data-schedule-select]');
  if(sched){
    const chosen = PRESETS[sched.value];
    if(chosen && chosen.schedule){
      updateItem(state, sched.dataset.scheduleSelect, {schedule: {...chosen.schedule}});
      ui.editing = null;
      ui.schedulePreset = null;
      return commit();
    }
    ui.schedulePreset = sched.value;
    return render();
  }
});

/* Commit on focusout. `blur` does not bubble, so focusout is what a delegated listener sees. */
appEl.addEventListener('focusout', e => {
  const input = e.target.closest('[data-field]');
  if(!input || ui.editing !== input.dataset.field) return;
  const changed = commitField(input);
  ui.editing = null;
  changed ? commit() : render();
});

appEl.addEventListener('keydown', e => {
  const input = e.target.closest('[data-field]');
  if(!input) return;

  if(e.key === 'Escape'){
    /* Restore before the re-render tears the input out, or the resulting native blur commits
       the discarded text. This is the ADR-0003 mechanic, and it is why the value is rendered
       as an attribute: defaultValue is the original. */
    input.value = input.defaultValue;
    ui.editing = null;
    render();
  } else if(e.key === 'Enter' && input.tagName !== 'TEXTAREA'){
    e.preventDefault();
    input.blur();
  }
});

appEl.addEventListener('submit', e => {
  const form = e.target;
  e.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());

  if(form.matches('[data-log-form]')){
    const mileage = Number(values.mileage);
    if(!Number.isFinite(mileage)) return;
    logCompletion(state, form.dataset.logForm, {mileage});
    closeForms();
    return commit();
  }

  if(form.matches('[data-add-asset-form]')){
    const parent = form.dataset.addAssetForm || null;
    const created = addAsset(state, parent, {name: values.name, category: values.category});
    closeForms();
    /* Straight into adding work for it — an asset with nothing scheduled does nothing. */
    if(created) ui.addingItemFor = created.id;
    return commit();
  }

  if(form.matches('[data-schedule-form]')){
    const schedule = scheduleFromForm(values.preset, values);
    if(!schedule) return;
    updateItem(state, form.dataset.scheduleForm, {schedule});
    closeForms();
    return commit();
  }

  if(form.matches('[data-add-item-form]')){
    const schedule = scheduleFromForm(values.preset, values);
    if(!schedule) return;
    addItem(state, form.dataset.addItemForm, {name: values.name, schedule});
    closeForms();
    return commit();
  }
});

/* ---- theme ------------------------------------------------------------------------------- */

document.getElementById('themeToggle').addEventListener('click', () => {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  saveTheme(next);
});

/* ---- start ------------------------------------------------------------------------------- */

window.addEventListener('hashchange', () => { readRoute(); render(); });

const loaded = loadState();
state = loaded.state;
if(loaded.status === 'corrupt') storageStatus = 'corrupt';

const savedTheme = loadTheme();
if(savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

readRoute();
render();

if('serviceWorker' in navigator){
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
