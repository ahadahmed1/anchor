/* ---- Persistence ----
   The bridge between bytes (js/storage.js) and shape (js/model.js). Storage stays ignorant of
   the model and the model stays ignorant of storage; this is the only file that knows both.

   Every load and save reports what happened rather than throwing or failing silently, because
   both failure modes are ones the user needs telling about: a blocked localStorage means
   changes will not survive a reload, and unreadable saved data means the app is starting
   empty. */

import { Store } from './storage.js';
import { normalize, emptyState, STATE_VERSION } from './model.js';

export const STATE_KEY = 'state';
export const THEME_KEY = 'theme';

/**
 * Load and normalize saved state.
 * @returns {state, status, detail}
 *   status: 'loaded'   existing data read cleanly
 *           'empty'    nothing saved yet — a first run
 *           'corrupt'  saved data could not be parsed; a copy was set aside, see `detail`
 */
export function loadState(store = Store){
  let raw;
  try{
    raw = store.getSync(STATE_KEY);
  }catch(e){
    return {state: emptyState(), status: 'empty', detail: null};
  }
  if(raw == null || raw === '') return {state: emptyState(), status: 'empty', detail: null};

  try{
    return {state: normalize(JSON.parse(raw)), status: 'loaded', detail: null};
  }catch(e){
    /* Starting empty over unreadable data would quietly destroy it on the next save. Set the
       original aside under its own key first — it is recoverable by hand, which is worth more
       than the space it costs. */
    const backupKey = `${STATE_KEY}.corrupt.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try{ store.setSync(backupKey, raw); }catch(e2){}
    return {state: emptyState(), status: 'corrupt', detail: backupKey};
  }
}

/**
 * Save state.
 * @returns {ok, reason}  reason is 'unavailable' when the write did not reach durable storage,
 *                        meaning it survives in memory for this session only.
 */
export function saveState(state, store = Store){
  let encoded;
  try{
    encoded = JSON.stringify({...state, version: STATE_VERSION});
  }catch(e){
    /* A cycle or a non-serializable value: a bug rather than an environment problem, and one
       that must not be reported as a storage failure. */
    return {ok: false, reason: 'encode'};
  }
  return store.setSync(STATE_KEY, encoded)
    ? {ok: true, reason: null}
    : {ok: false, reason: 'unavailable'};
}

/* Theme is read before first paint to avoid a flash, so it has a synchronous path of its own
   and never goes through the state blob. */
export function loadTheme(store = Store){ return store.getSync(THEME_KEY); }
export function saveTheme(theme, store = Store){ return store.setSync(THEME_KEY, theme); }

/** Keys set aside by a corrupt load, newest first. Nothing deletes these automatically. */
export function corruptBackups(store = Store){
  const keys = [];
  try{
    const ls = globalThis.localStorage;
    if(!ls) return keys;
    for(let i = 0; i < ls.length; i++){
      const k = ls.key(i);
      if(k && k.includes(`${STATE_KEY}.corrupt.`)) keys.push(k);
    }
  }catch(e){}
  return keys.sort().reverse();
}
