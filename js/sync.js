/* ---- Cross-device sync ----
   Optional layer on top of Store (js/storage.js): when a sync code is set, the app also
   pushes/pulls the same JSON blob Store already persists locally to/from a small
   Cloudflare Worker. This exists because browser storage is scoped per *storage origin*,
   and on iOS an installed home-screen app is a separate origin from Safari itself, even
   for the same URL — so data entered in one never appears in the other without an
   explicit sync step like this.

   The sync code is both the lookup key and the bearer secret: no accounts, no server-
   side identity beyond "whoever holds this code." Local Store stays the source of truth
   for instant/offline reads and writes; the Worker is best-effort. */
const Sync = (function(){
  /* Set after deploying the worker (see worker/README.md), e.g.
     'https://anchor-sync.<your-subdomain>.workers.dev/sync/' */
  const ENDPOINT = 'https://REPLACE_WITH_WORKER_URL/sync/';
  const TIMEOUT_MS = 6000;

  let code = null;
  let status = 'off'; // 'off' | 'syncing' | 'synced' | 'error'
  let lastSyncedAt = null;
  const listeners = [];

  function notify(){ listeners.forEach(fn=>{ try{ fn({status, lastSyncedAt}); }catch(e){} }); }

  function genCode(){
    const bytes = new Uint8Array(15);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(36).padStart(2,'0')).join('').slice(0, 24);
  }

  function fetchWithTimeout(url, options){
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);
    return fetch(url, Object.assign({}, options, {signal: controller.signal}))
      .finally(()=>clearTimeout(timer));
  }

  async function init(){
    code = await Store.get('syncCode');
    status = code ? 'synced' : 'off';
    notify();
  }

  function isOn(){ return !!code; }

  async function start(){
    code = genCode();
    await Store.set('syncCode', code);
    status = 'synced';
    notify();
    return code;
  }

  async function link(enteredCode){
    code = (enteredCode||'').trim();
    await Store.set('syncCode', code);
    notify();
    return pull();
  }

  async function stop(){
    code = null;
    await Store.remove('syncCode');
    status = 'off';
    notify();
  }

  /** Push a JSON string (the same value passed to Store.set('domains', ...)) to the worker. */
  async function push(dataString, updatedAt){
    if(!code) return;
    status = 'syncing'; notify();
    try{
      const res = await fetchWithTimeout(ENDPOINT + code, {
        method: 'PUT',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({data: dataString, updatedAt})
      });
      if(!res.ok) throw new Error('push failed: ' + res.status);
      status = 'synced'; lastSyncedAt = new Date().toISOString(); notify();
    }catch(e){
      status = 'error'; notify();
    }
  }

  /** Returns {data, updatedAt} — the remote domains JSON string and the stamp it was pushed
      with — or null if nothing's synced yet / on failure. The caller needs updatedAt to tell
      whether the remote copy is actually newer than what's on this device; without it the only
      possible policy is "remote always wins", which silently discards edits made offline. */
  async function pull(){
    if(!code) return null;
    status = 'syncing'; notify();
    try{
      const res = await fetchWithTimeout(ENDPOINT + code, {method:'GET'});
      if(res.status === 404){ status = 'synced'; notify(); return null; }
      if(!res.ok) throw new Error('pull failed: ' + res.status);
      const body = await res.json();
      status = 'synced'; lastSyncedAt = new Date().toISOString(); notify();
      return {data: body.data, updatedAt: body.updatedAt};
    }catch(e){
      status = 'error'; notify();
      return null;
    }
  }

  function onChange(fn){ listeners.push(fn); }

  return {
    init, isOn, start, link, stop, push, pull, onChange,
    get status(){ return status; },
    get code(){ return code; },
    get lastSyncedAt(){ return lastSyncedAt; }
  };
})();
