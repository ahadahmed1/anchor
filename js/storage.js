/* ---- Storage ----
   Replaces the Claude.ai artifact-only `window.storage` API with localStorage.
   Keeps an async surface (get/set return promises) so callers read the same as
   before, plus a sync pair used for the pre-paint theme read.
   Falls back to an in-memory map when localStorage is unavailable (private
   browsing, blocked cookies, some file:// contexts) so nothing throws. */
const Store = (function(){
  const PREFIX = 'projectLedger:';
  const memory = new Map();

  let backed = false;
  try{
    const probe = PREFIX + '__probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    backed = true;
  }catch(e){ backed = false; }

  function getSync(key){
    if(backed){
      try{ return window.localStorage.getItem(PREFIX + key); }catch(e){}
    }
    return memory.has(key) ? memory.get(key) : null;
  }

  function setSync(key, value){
    memory.set(key, value);
    if(!backed) return false;
    try{
      window.localStorage.setItem(PREFIX + key, value);
      return true;
    }catch(e){
      /* Quota exceeded, or storage disabled mid-session. */
      return false;
    }
  }

  function removeSync(key){
    memory.delete(key);
    if(backed){
      try{ window.localStorage.removeItem(PREFIX + key); }catch(e){}
    }
  }

  return {
    /** True when writes actually survive a reload. */
    get persistent(){ return backed; },
    getSync: getSync,
    setSync: setSync,
    get: function(key){ return Promise.resolve(getSync(key)); },
    set: function(key, value){
      return setSync(key, value)
        ? Promise.resolve()
        : Promise.reject(new Error('storage unavailable'));
    },
    remove: function(key){ removeSync(key); return Promise.resolve(); }
  };
})();
