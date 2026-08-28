/* ---- App ----
   The only file that touches the DOM. Everything it renders comes from js/view.js as a string,
   so a change means recomputing one innerHTML rather than tracking which nodes moved. At this
   size that is simpler than diffing and impossible to get subtly wrong.

   All interaction is delegated from two roots, so nothing needs re-binding after a render. */

import { loadState, saveState, loadTheme, saveTheme } from './persist.js';
import { addAsset, addItem, logCompletion, findAsset } from './model.js';
import { buildTimeline } from './timeline.js';
import {
  renderTimeline, renderAssets, renderTabs, renderStorageWarning,
  renderAddAsset, renderAddItem, scheduleFromForm,
} from './view.js';

const appEl = document.getElementById('app');
const chromeEl = document.getElementById('chrome');

let state;
let storageStatus = 'ok';

/* View-only state. Nothing here is persisted: it describes what is open on screen, not data. */
const ui = {
  tab: 'due',
  openLogId: null,              // mileage item awaiting an odometer reading
  addingAssetUnder: undefined,  // undefined = closed; null = top level; id = nested
  addingItemFor: null,
  itemPreset: '3-months',
};

/* ---- routing ----------------------------------------------------------------------------- */
/* Hash-based, because GitHub Pages will not rewrite unknown paths to index.html and a real
   path would 404 on a deep link. See ADR-0004. */

function readRoute(){
  ui.tab = location.hash === '#/assets' ? 'assets' : 'due';
}
function goto(tab){
  location.hash = tab === 'assets' ? '#/assets' : '';
}

/* ---- render ------------------------------------------------------------------------------ */

function render(){
  chromeEl.innerHTML = renderTabs(ui.tab);

  let html = renderStorageWarning(storageStatus);

  if(ui.addingAssetUnder !== undefined) html += renderAddAsset(ui.addingAssetUnder);
  if(ui.addingItemFor){
    const hit = findAsset(state, ui.addingItemFor);
    if(hit) html += renderAddItem(hit.asset, ui.itemPreset);
  }

  html += ui.tab === 'assets'
    ? renderAssets(state)
    : renderTimeline(buildTimeline(state), ui.openLogId);

  appEl.innerHTML = html;

  const focus = appEl.querySelector('.reading-input, .form input[name="name"]');
  if(focus) focus.focus();
}

/** Persist, and surface the outcome rather than letting a failed save pass unnoticed. */
function commit(){
  const result = saveState(state);
  if(!result.ok && storageStatus === 'ok') storageStatus = 'unavailable';
  render();
}

function closeForms(){
  ui.openLogId = null;
  ui.addingAssetUnder = undefined;
  ui.addingItemFor = null;
}

/* ---- events ------------------------------------------------------------------------------ */

chromeEl.addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]');
  if(tab){ closeForms(); goto(tab.dataset.tab); }
});

appEl.addEventListener('click', e => {
  const el = sel => e.target.closest(sel);

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
  const select = e.target.closest('[data-preset-select]');
  if(!select) return;
  ui.itemPreset = select.value;
  render();
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
