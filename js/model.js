/* ---- Data model ----
   Asset -> Item -> Entry, with assets nestable (a furnace inside a house). See ADR-0007.

     Asset   a thing you maintain: a car, a property, an appliance, a person, an account.
             Carries a category, which drives its extra fields and is what the old "Domains"
             become — a filter, not a level of the tree.
     Item    a thing with a schedule. There is no `kind` and no `status`: an item is due or it
             is not, and a one-off is just a schedule of type 'once'. See ADR-0006.
     Entry   a completion, appended to an item's log. Never edited into place.

   THE RULE THAT MATTERS MOST HERE: nothing is ever removed from an array. Every record carries
   `updatedAt` and `deletedAt`, and deleting sets a tombstone. There is no sync layer yet, so
   this looks like ceremony for nothing — it is not. A merge added later cannot reconstruct
   deletions that were implemented as removals, and the point of doing it now is that there is
   no data to migrate. See ADR-0008.

   Consequence: every read has to skip tombstones. Rather than trusting each call site to
   remember, the live* helpers below are the only sanctioned way to walk a collection. */

import { nextDue } from './schedule.js';

export const STATE_VERSION = 1;

/* Category drives an asset's extra fields, the examples the forms show, and whether the thing
   has an odometer. Adding one is an edit here.

   `example` / `itemExample` are placeholder text. They are per-category because a single
   hard-coded example ("2019 Honda CR-V") is actively misleading on every other kind — it reads
   as an instruction rather than an illustration.

   `tracksMileage` gates the "every N miles" schedule. Only something with an odometer can be
   scheduled by distance, and offering it elsewhere produces items that can never come due. */
export const CATEGORIES = {
  car:       {label: 'Car', tracksMileage: true,
              example: '2019 Honda CR-V', itemExample: 'Oil change',
              fields: [
                {key: 'make',    label: 'Make',     type: 'text'},
                {key: 'model',   label: 'Model',    type: 'text'},
                {key: 'year',    label: 'Year',     type: 'text'},
                {key: 'plate',   label: 'Plate',    type: 'text'},
                {key: 'mileage', label: 'Odometer', type: 'number'},
             ]},
  home:      {label: 'Home',
              example: '123 Main St', itemExample: 'Clean the gutters',
              fields: [{key: 'address', label: 'Address', type: 'text'}]},
  appliance: {label: 'Appliance',
              example: 'Furnace', itemExample: 'Replace the filter',
              fields: [
                {key: 'brand',     label: 'Brand',     type: 'text'},
                {key: 'model',     label: 'Model',     type: 'text'},
                {key: 'installed', label: 'Installed', type: 'date'},
             ]},
  person:    {label: 'Person',
              example: 'Ahad', itemExample: 'Annual physical',
              fields: [{key: 'provider', label: 'Provider', type: 'text'}]},
  finance:   {label: 'Finance',
              example: 'Home insurance', itemExample: 'Review the policy',
              fields: [
                {key: 'provider', label: 'Provider', type: 'text'},
                {key: 'account',  label: 'Account',  type: 'text'},
             ]},
  digital:   {label: 'Digital',
              example: 'Domain name', itemExample: 'Renew it',
              fields: [{key: 'account', label: 'Account / service', type: 'text'}]},
  outdoor:   {label: 'Outdoor',
              example: 'Lawn', itemExample: 'Fertilise',
              fields: []},
  other:     {label: 'Other',
              example: 'Something you look after', itemExample: 'Check on it',
              fields: []},
};

export const CATEGORY_ORDER = ['car', 'home', 'appliance', 'person', 'finance', 'digital', 'outdoor', 'other'];

/* ---- identity + timestamps --------------------------------------------------------------- */

/** Ids must be unique across devices that have never met, so they are random, not sequential. */
export function newId(){
  if(typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function nowStamp(){ return new Date().toISOString(); }

/** Stamp a record as modified. Every mutation in this module goes through here. */
function touch(record){
  record.updatedAt = nowStamp();
  return record;
}

/* ---- tombstone-aware reads --------------------------------------------------------------- */
/* Use these. A bare `asset.items.map(...)` is a bug waiting to surface the moment sync lands. */

export const isLive = record => !!record && !record.deletedAt;

export function liveAssets(parent){ return ((parent && parent.assets) || []).filter(isLive); }
export function liveItems(asset){ return ((asset && asset.items) || []).filter(isLive); }
export function liveLog(item){ return ((item && item.log) || []).filter(isLive); }

/* ---- construction ------------------------------------------------------------------------ */

export function emptyState(){
  return {version: STATE_VERSION, assets: []};
}

/* The three constructors accept their own timestamps. Loading from storage needs that to
   preserve history, and it keeps tests able to build a record that was created last year. */
export function makeAsset(props = {}){
  const stamp = nowStamp();
  return {
    id: props.id || newId(),
    name: props.name || '',
    category: CATEGORIES[props.category] ? props.category : 'other',
    fields: {...(props.fields || {})},
    assets: [],
    items: [],
    createdAt: props.createdAt || stamp,
    updatedAt: props.updatedAt || stamp,
    deletedAt: props.deletedAt || null,
  };
}

export function makeItem(props = {}){
  const stamp = nowStamp();
  return {
    id: props.id || newId(),
    name: props.name || '',
    notes: props.notes || '',
    schedule: props.schedule || null,
    leadDays: props.leadDays != null ? Number(props.leadDays) : null,
    checklist: props.checklist || [],
    log: [],
    createdAt: props.createdAt || stamp,
    updatedAt: props.updatedAt || stamp,
    deletedAt: props.deletedAt || null,
  };
}

export function makeEntry(props = {}){
  const stamp = nowStamp();
  return {
    id: props.id || newId(),
    date: props.date || stamp.slice(0, 10),
    note: props.note || '',
    cost: props.cost != null && props.cost !== '' ? String(props.cost) : '',
    /* Recorded on the entry, not the asset, so the odometer history is preserved. The asset's
       own `fields.mileage` is the current reading and is updated alongside. */
    mileage: props.mileage != null && props.mileage !== '' ? Number(props.mileage) : null,
    /* Household attribution. Unused until identity exists, but entries are append-only and
       backfilling this later would mean every existing entry reads as "unknown". */
    by: props.by || null,
    createdAt: props.createdAt || stamp,
    deletedAt: props.deletedAt || null,
  };
}

/* ---- traversal --------------------------------------------------------------------------- */

/** Depth-first over live assets, yielding {asset, parent, depth}. */
export function walkAssets(state, visit){
  const step = (list, parent, depth) => {
    for(const asset of (list || []).filter(isLive)){
      visit({asset, parent, depth});
      step(asset.assets, asset, depth + 1);
    }
  };
  step(state && state.assets, null, 0);
}

export function findAsset(state, id){
  let found = null;
  walkAssets(state, ({asset, parent}) => { if(asset.id === id) found = {asset, parent}; });
  return found;
}

/** An item plus the asset that owns it, or null. */
export function findItem(state, id){
  let found = null;
  walkAssets(state, ({asset}) => {
    for(const item of liveItems(asset)) if(item.id === id) found = {item, asset};
  });
  return found;
}

/** Every live item in the tree, each with its owning asset. */
export function allItems(state){
  const out = [];
  walkAssets(state, ({asset}) => {
    for(const item of liveItems(asset)) out.push({item, asset});
  });
  return out;
}

/* ---- mutation ---------------------------------------------------------------------------- */

/** Add an asset, optionally nested under another. Returns the new asset, or null if the parent
    does not exist. */
export function addAsset(state, parentId, props){
  const asset = makeAsset(props);
  if(parentId == null){
    state.assets.push(asset);
    return asset;
  }
  const hit = findAsset(state, parentId);
  if(!hit) return null;
  hit.asset.assets.push(asset);
  touch(hit.asset);
  return asset;
}

export function addItem(state, assetId, props){
  const hit = findAsset(state, assetId);
  if(!hit) return null;
  const item = makeItem(props);
  hit.asset.items.push(item);
  touch(hit.asset);
  return item;
}

const ASSET_PATCHABLE = ['name', 'category', 'fields'];
const ITEM_PATCHABLE = ['name', 'notes', 'schedule', 'leadDays', 'checklist'];

function applyPatch(record, patch, allowed){
  for(const key of allowed){
    if(Object.prototype.hasOwnProperty.call(patch, key)) record[key] = patch[key];
  }
  return touch(record);
}

export function updateAsset(state, id, patch){
  const hit = findAsset(state, id);
  return hit ? applyPatch(hit.asset, patch, ASSET_PATCHABLE) : null;
}

export function updateItem(state, id, patch){
  const hit = findItem(state, id);
  return hit ? applyPatch(hit.item, patch, ITEM_PATCHABLE) : null;
}

/**
 * Log a completion. This is the app's most frequent write.
 * A mileage reading also updates the owning asset's odometer, since that is the same fact.
 */
export function logCompletion(state, itemId, props = {}){
  const hit = findItem(state, itemId);
  if(!hit) return null;
  const entry = makeEntry(props);
  hit.item.log.push(entry);
  touch(hit.item);
  if(entry.mileage != null && Number.isFinite(entry.mileage)){
    hit.asset.fields = {...hit.asset.fields, mileage: entry.mileage};
    touch(hit.asset);
  }
  return entry;
}

/* ---- deletion (always soft) -------------------------------------------------------------- */

function tombstone(record){
  if(!record || record.deletedAt) return record;
  record.deletedAt = nowStamp();
  return touch(record);
}

/**
 * Soft-delete an asset and everything under it.
 *
 * The cascade is deliberate. Tombstoning only the asset would leave its descendants with no
 * record of their own deletion, and a merge that resolves per record would keep resurrecting
 * them onto a device that had never seen the parent go.
 */
export function deleteAsset(state, id){
  const hit = findAsset(state, id);
  if(!hit) return null;
  const cascade = asset => {
    tombstone(asset);
    for(const child of asset.assets || []) cascade(child);
    for(const item of asset.items || []) tombstone(item);
  };
  cascade(hit.asset);
  if(hit.parent) touch(hit.parent);
  return hit.asset;
}

export function deleteItem(state, id){
  const hit = findItem(state, id);
  if(!hit) return null;
  tombstone(hit.item);
  touch(hit.asset);
  return hit.item;
}

/** Log entries are append-only, so correcting one means tombstoning it and adding another. */
export function deleteEntry(state, itemId, entryId){
  const hit = findItem(state, itemId);
  if(!hit) return null;
  const entry = (hit.item.log || []).find(e => e.id === entryId);
  if(!entry) return null;
  tombstone(entry);
  touch(hit.item);
  return entry;
}

/* ---- derived views ----------------------------------------------------------------------- */

/**
 * How much lives inside an asset, counting live records only.
 * Deleting an asset cascades, so the UI needs this to say what a delete will actually take
 * with it rather than asking for confirmation of an unstated consequence.
 */
export function countWithin(asset){
  let assets = 0, items = 0;
  const walk = a => {
    items += liveItems(a).length;
    for(const child of liveAssets(a)){ assets++; walk(child); }
  };
  walk(asset);
  return {assets, items};
}

/** An asset's current odometer reading, or null. Only cars carry one. */
export function assetMileage(asset){
  const raw = asset && asset.fields ? asset.fields.mileage : null;
  if(raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every live item with its due state resolved — the input to the home timeline.
 * Nothing is stored: due state is computed on every call, per ADR-0002.
 */
export function dueForAll(state, ctx = {}){
  return allItems(state).map(({item, asset}) => ({
    item,
    asset,
    due: nextDue({...item, log: liveLog(item)}, {now: ctx.now, mileage: assetMileage(asset)}),
  }));
}

/* ---- loading ----------------------------------------------------------------------------- */

/**
 * Coerce whatever came out of storage into a shape the app can walk without checking for
 * absent arrays at every turn. Unknown records are dropped rather than repaired: a half-valid
 * asset is worse than a missing one.
 */
export function normalize(raw){
  if(!raw || typeof raw !== 'object' || !Array.isArray(raw.assets)) return emptyState();
  const asset = a => {
    if(!a || typeof a !== 'object' || !a.id) return null;
    const out = makeAsset(a);
    out.assets = (Array.isArray(a.assets) ? a.assets : []).map(asset).filter(Boolean);
    out.items = (Array.isArray(a.items) ? a.items : []).map(item).filter(Boolean);
    return out;
  };
  const item = i => {
    if(!i || typeof i !== 'object' || !i.id) return null;
    const out = makeItem({...i, checklist: Array.isArray(i.checklist) ? i.checklist : []});
    out.log = (Array.isArray(i.log) ? i.log : []).map(entry).filter(Boolean);
    return out;
  };
  const entry = e => {
    if(!e || typeof e !== 'object' || !e.id) return null;
    return makeEntry(e);
  };
  return {version: STATE_VERSION, assets: raw.assets.map(asset).filter(Boolean)};
}
