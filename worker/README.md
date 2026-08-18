# Anchor sync worker

A minimal Cloudflare Worker + KV namespace that backs Anchor's cross-device sync
(see `js/sync.js`). No accounts, no database beyond one KV namespace — a long random
"sync code" generated client-side is both the KV lookup key and the bearer secret.

## Deploy (one-time, from your own machine or this environment)

Requires a free Cloudflare account (no credit card needed for this).

```bash
cd worker

# 1. Log in — opens a browser tab to authorize the CLI against your Cloudflare account.
npx wrangler login

# 2. Create the KV namespace.
npx wrangler kv namespace create SYNC_KV
# Prints something like:
#   { binding = "SYNC_KV", id = "abcd1234..." }
# Paste that id into wrangler.toml, replacing REPLACE_WITH_KV_NAMESPACE_ID.

# 3. Deploy.
npx wrangler deploy
# Prints the Worker's URL, e.g. https://anchor-sync.<your-subdomain>.workers.dev
```

Then in `js/sync.js`, set `ENDPOINT` to that URL plus `/sync/`:

```js
const ENDPOINT = 'https://anchor-sync.<your-subdomain>.workers.dev/sync/';
```

Commit that change, and the deployed static site (GitHub Pages) will start using it.

## Redeploying after changes

```bash
cd worker && npx wrangler deploy
```

## Local testing

```bash
cd worker && npx wrangler dev --local --port 8787
```

Then point `js/sync.js`'s `ENDPOINT` at `http://localhost:8787/sync/` temporarily while
testing — don't commit that pointed at localhost.

## API

- `PUT /sync/:code` — body `{"data": "<domains JSON string>", "updatedAt": "<ISO8601>"}`,
  overwrites whatever is stored under `:code`.
- `GET /sync/:code` — returns the same shape, `404` if nothing's been synced under that
  code yet.
- `:code` must be 20–40 alphanumeric characters (matches what `js/sync.js` generates).
  Requests with a malformed code or an oversized body (>2MB) are rejected before
  touching KV.
