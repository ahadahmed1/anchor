/* ---- Anchor sync worker ----
   Minimal cross-device sync for a single-user app: no accounts, no database beyond one
   KV namespace. A long random "sync code" (generated client-side, see js/sync.js) is
   both the KV lookup key and the bearer secret — knowing the code is equivalent to
   being the user, the same trust model as a shareable secret link.

   PUT /sync/:code  body: {"data": "<domains JSON string>", "updatedAt": "<ISO8601>"}
   GET /sync/:code  -> the same {"data", "updatedAt"} shape, 404 if never synced. */

const CODE_RE = /^[A-Za-z0-9]{20,40}$/;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB — generous for a personal task list

function corsHeaders(origin){
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}
function respond(body, status, origin, extraHeaders){
  return new Response(body, {
    status,
    headers: Object.assign({}, corsHeaders(origin), extraHeaders || {})
  });
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if(request.method === 'OPTIONS'){
      return respond(null, 204, origin);
    }

    const match = url.pathname.match(/^\/sync\/([^/]+)\/?$/);
    if(!match){
      return respond('Not found', 404, origin);
    }
    const code = match[1];
    if(!CODE_RE.test(code)){
      return respond('Invalid sync code', 400, origin);
    }

    if(request.method === 'GET'){
      const stored = await env.SYNC_KV.get(code);
      if(stored == null) return respond('Not found', 404, origin);
      return respond(stored, 200, origin, { 'Content-Type': 'application/json' });
    }

    if(request.method === 'PUT'){
      const contentLength = Number(request.headers.get('Content-Length') || '0');
      if(contentLength > MAX_BODY_BYTES){
        return respond('Payload too large', 413, origin);
      }
      const bodyText = await request.text();
      if(bodyText.length > MAX_BODY_BYTES){
        return respond('Payload too large', 413, origin);
      }
      let parsed;
      try{ parsed = JSON.parse(bodyText); }
      catch(e){ return respond('Invalid JSON', 400, origin); }
      if(typeof parsed.data !== 'string' || typeof parsed.updatedAt !== 'string'){
        return respond('Malformed body — expected {data, updatedAt}', 400, origin);
      }
      await env.SYNC_KV.put(code, bodyText);
      return respond(bodyText, 200, origin, { 'Content-Type': 'application/json' });
    }

    return respond('Method not allowed', 405, origin);
  }
};
