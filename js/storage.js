/* ---- Storage ----
   A key/value wrapper over localStorage that knows nothing about the data model. Kept that way
   deliberately: this is the single place that touches persistence, so it is also the single
   place to swap in IndexedDB if the data ever outgrows localStorage.

   Salvaged from the previous app, which got the important part right — falling back to an
   in-memory map when localStorage is unavailable (private browsing, blocked cookies, some
   file:// contexts) so nothing throws and the session stays usable. Changes here:

   - An ES module with an injectable backend, rather than a global IIFE reading
     `window.localStorage` directly. The app imports `Store`; tests build their own.
   - The prefix is `anchor:`. The old app's data lives under `projectLedger:` and is
     deliberately not imported — see ADR-0006.
   - A write that fails while localStorage is otherwise working (quota) no longer strands the
     value. The old version wrote to memory, returned false, and then kept reading the stale
     localStorage value, so the write was lost even within the session. */

const PREFIX = 'anchor:';

/** The ambient localStorage, or null when there isn't one or it throws on use. */
function detectBackend(){
  try{
    const ls = globalThis.localStorage;
    if(!ls) return null;
    const probe = PREFIX + '__probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  }catch(e){
    return null;
  }
}

/**
 * @param backend a localStorage-shaped object, or null to run purely in memory
 * @param prefix  namespace for every key
 */
export function createStore(backend, prefix = PREFIX){
  const memory = new Map();
  /* Keys whose last write did not reach the backend. Reads for these must come from memory,
     or the backend's stale value silently wins. */
  const unbacked = new Set();
  let backed = !!backend;

  function getSync(key){
    if(backed && !unbacked.has(key)){
      try{
        const v = backend.getItem(prefix + key);
        if(v !== null) return v;
      }catch(e){
        /* Storage was pulled out from under us mid-session; fall through to memory. */
        backed = false;
      }
    }
    return memory.has(key) ? memory.get(key) : null;
  }

  function setSync(key, value){
    memory.set(key, String(value));
    if(!backed){ unbacked.add(key); return false; }
    try{
      backend.setItem(prefix + key, String(value));
      unbacked.delete(key);
      return true;
    }catch(e){
      /* Quota exceeded, or storage disabled mid-session. The value survives in memory for the
         rest of the session, and reads for this key now come from there. */
      unbacked.add(key);
      return false;
    }
  }

  function removeSync(key){
    memory.delete(key);
    unbacked.delete(key);
    if(backed){
      try{ backend.removeItem(prefix + key); }catch(e){}
    }
  }

  return {
    /** True when writes are expected to survive a reload. */
    get persistent(){ return backed; },
    /** Keys written this session that did not reach durable storage. */
    get pending(){ return [...unbacked]; },
    getSync,
    setSync,
    removeSync,
    get(key){ return Promise.resolve(getSync(key)); },
    set(key, value){
      return setSync(key, value)
        ? Promise.resolve()
        : Promise.reject(new Error('storage unavailable'));
    },
    remove(key){ removeSync(key); return Promise.resolve(); },
  };
}

/** The instance the app uses. */
export const Store = createStore(detectBackend());
