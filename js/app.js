/* ---- App ----
   The only file that touches the DOM. Everything it renders comes from js/view.js as a string,
   so a change means recomputing one innerHTML rather than tracking which nodes moved. At this
   size that is simpler than diffing and impossible to get subtly wrong.

   All interaction is delegated from two roots, so nothing needs re-binding after a render. */

import { loadState, saveState, loadTheme, saveTheme } from './persist.js';
import {
  addAsset, addItem, logCompletion, findAsset, findItem,
  updateItem, updateAsset, deleteItem, deleteAsset, deleteEntry, liveLog, assetMileage,
} from './model.js';
import { buildTimeline } from './timeline.js';
import { nextDue } from './schedule.js';
import {
  renderTimeline, renderAssets, renderTabs, renderStorageWarning,
  renderAddAsset, renderAddItem, renderItemDetail, renderAssetDetail,
  scheduleFromForm, PRESETS,
} from './view.js';

const appEl = document.getElementById('app');
const chromeEl = document.getElementById('chrome');

let state;
let storageStatus = 'ok';

/* View-only state. Nothing here is persisted: it describes what is open on screen, not data. */
const ui = {
  tab: 'due',
  itemId: null,                 // set when viewing an item's detail page
  assetId: null,                // set when viewing an asset's detail page
  editing: null,                // the single field currently editable, per ADR-0003
  schedulePreset: null,         // null = whatever the item already is; else the chosen preset
  confirmingDelete: null,       // asset awaiting an inline delete confirmation
  openLogId: null,              // mileage item awaiting an odometer reading
  addingAssetUnder: undefined,  // undefined = closed; null = top level; id = nested
  addingItemFor: null,
  itemPreset: '3-months',
  assetCategory: 'car',         // the Kind chosen in the add-asset form, which drives its example
  customUnit: null,             // weeks/months, when the Custom… preset is chosen
  showStart: false,             // the start-date picker is hidden until asked for
  start: null,                  // a start date the user picked, kept across re-renders
};

/* ---- routing ----------------------------------------------------------------------------- */
/* Hash-based, because GitHub Pages will not rewrite unknown paths to index.html and a real
   path would 404 on a deep link. See ADR-0004. */

function readRoute(){
  const hash = location.hash || '';
  const item = /^#\/item\/(.+)$/.exec(hash);
  const asset = /^#\/asset\/(.+)$/.exec(hash);
  ui.itemId = item ? decodeURIComponent(item[1]) : null;
  ui.assetId = asset ? decodeURIComponent(asset[1]) : null;
  /* An asset page belongs to the Assets tab, so Back from it lands where you came from. */
  if(hash === '#/assets' || ui.assetId) ui.tab = 'assets';
  else if(!ui.itemId) ui.tab = 'due';
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
  const assetHit = ui.assetId ? findAsset(state, ui.assetId) : null;

  /* A detail page is a place, not a panel: it replaces the tabs rather than sitting under
     them, so there is one way back and it is the Back button. */
  chromeEl.innerHTML = (row || assetHit) ? '' : renderTabs(ui.tab);

  let html = renderStorageWarning(storageStatus);

  if(row){
    html += renderItemDetail(row, ui);
  } else if(assetHit){
    /* The asset page renders its own add forms, inline in the section each was triggered from,
       rather than appended after the delete button at the bottom of the page. */
    html += renderAssetDetail(assetHit.asset, ui);
  } else {
    if(ui.itemId || ui.assetId){
      /* Deep link to something deleted or never existing. Say so rather than showing a blank. */
      html += `<p class="warning" role="alert">That ${ui.itemId ? 'item' : 'asset'} no longer exists.</p>`;
      ui.itemId = null;
      ui.assetId = null;
    }
    if(ui.addingAssetUnder !== undefined) html += renderAddAsset(ui.addingAssetUnder, ui.assetCategory);
    if(ui.addingItemFor){
      const hit = findAsset(state, ui.addingItemFor);
      if(hit) html += renderAddItem(hit.asset, ui.itemPreset, ui);
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
  ui.confirmingDelete = null;
  ui.customUnit = null;
  ui.showStart = false;
  ui.start = null;
  ui.addingAssetUnder = undefined;
  ui.addingItemFor = null;
}

/* ---- read-first editing ------------------------------------------------------------------ */
/* One field is editable at a time. Committing on focusout means Escape has to leave the input
   holding its original value before the re-render removes it — removing a focused input fires
   a native blur, and a changed value would then be committed by the very keystroke meant to
   discard it. See ADR-0003, where this cost a bug the first time round. */

/* Field keys are `kind:id[:subkey]`. Ids are UUIDs and carry no colons, so splitting is safe. */
function commitField(input){
  const key = input.dataset.field;
  if(!key) return false;
  const [kind, id, subkey] = key.split(':');
  const value = input.value;

  if(kind === 'name' || kind === 'notes'){
    const hit = findItem(state, id);
    if(!hit || hit.item[kind] === value) return false;
    updateItem(state, id, {[kind]: value});
    return true;
  }

  if(kind === 'aname'){
    const hit = findAsset(state, id);
    if(!hit || hit.asset.name === value) return false;
    updateAsset(state, id, {name: value});
    return true;
  }

  if(kind === 'afield'){
    const hit = findAsset(state, id);
    if(!hit) return false;
    const before = hit.asset.fields[subkey];
    /* Blank clears the field rather than storing an empty string, so assetMileage and the
       category field renderers see one kind of absent. */
    const next = value === '' ? undefined : value;
    if((before == null ? '' : String(before)) === value) return false;
    const fields = {...hit.asset.fields};
    if(next === undefined) delete fields[subkey]; else fields[subkey] = next;
    updateAsset(state, id, {fields});
    return true;
  }

  return false;
}

/* ---- events ------------------------------------------------------------------------------ */

chromeEl.addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]');
  /* goto() takes a hash, not a tab name. Passing 'assets' here set location.hash to '#assets',
     which matches no route, so the Assets tab silently did nothing. */
  if(tab){ closeForms(); goto(tab.dataset.tab === 'assets' ? '#/assets' : ''); }
});

appEl.addEventListener('click', e => {
  const el = sel => e.target.closest(sel);

  const open = el('[data-open-item]');
  if(open){
    closeForms();
    return goto('#/item/' + encodeURIComponent(open.dataset.openItem));
  }

  const openAsset = el('[data-open-asset]');
  if(openAsset){
    closeForms();
    return goto('#/asset/' + encodeURIComponent(openAsset.dataset.openAsset));
  }

  const setCat = el('[data-set-category]');
  if(setCat){
    const [assetId, category] = setCat.dataset.setCategory.split('|');
    updateAsset(state, assetId, {category});
    ui.editing = null;
    return commit();
  }

  const confirmDel = el('[data-confirm-delete-asset]');
  if(confirmDel){
    ui.confirmingDelete = confirmDel.dataset.confirmDeleteAsset;
    return render();
  }

  const delAsset = el('[data-delete-asset]');
  if(delAsset){
    const hit = findAsset(state, delAsset.dataset.deleteAsset);
    const parentId = hit && hit.parent ? hit.parent.id : null;
    deleteAsset(state, delAsset.dataset.deleteAsset);
    closeForms();
    /* Back to the parent if there is one, otherwise the list — never a dead page. */
    goto(parentId ? '#/asset/' + encodeURIComponent(parentId) : '#/assets');
    return commit();
  }

  const addItemBtn = el('[data-add-item]');
  if(addItemBtn){
    closeForms();
    ui.addingItemFor = addItemBtn.dataset.addItem;
    ui.itemPreset = '3-months';
    return render();
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

  if(el('[data-show-start]')){
    /* Keep whatever is already in the hidden field so revealing the picker does not reset it. */
    const current = appEl.querySelector('[name="start"]');
    ui.start = current ? current.value : null;
    ui.showStart = true;
    return render();
  }

  const addAssetBtn = el('[data-add-asset]');
  if(addAssetBtn){
    const under = addAssetBtn.dataset.addAsset;
    closeForms();
    /* "1" is the top-level button; anything else is an asset id to nest under. */
    ui.addingAssetUnder = under && under !== '1' ? under : null;
    ui.assetCategory = 'car';
    return render();
  }
});

/* Changing the schedule preset re-renders the form so the right extra field appears. */
appEl.addEventListener('change', e => {
  const preset = e.target.closest('[data-preset-select]');
  if(preset){
    ui.itemPreset = preset.value;
    ui.customUnit = null;
    return render();
  }

  /* Preserve the fields around the unit dropdown across the re-render it causes. */
  const unit = e.target.closest('[name="unit"]');
  if(unit){
    const form = unit.closest('form');
    const every = form && form.querySelector('[name="every"]');
    const start = form && form.querySelector('[name="start"]');
    ui.customUnit = unit.value;
    if(start) ui.start = start.value;
    if(every) ui.everyDraft = every.value;
    return render();
  }

  /* Kind drives the name example, so the form re-renders on change. */
  const cat = e.target.closest('[data-category-select]');
  if(cat){
    ui.assetCategory = cat.value;
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
    if(created){
      /* Land on the new asset and open the add-item form straight away — an asset with
         nothing scheduled does nothing, so this is always the next step. */
      ui.addingItemFor = created.id;
      ui.itemPreset = '3-months';
      goto('#/asset/' + encodeURIComponent(created.id));
    }
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
