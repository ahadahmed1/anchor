# Project Ledger

An offline-first PWA for tracking work at four levels: **project → epic → story → task**.
Started life as a Claude.ai artifact; now a plain static site with no build step and no
dependencies.

## Running it locally

A service worker needs http/https, so serve the folder rather than opening the file:

    python3 -m http.server 8000

then open <http://localhost:8000>. (`npx serve .` works too if you have Node installed.)

Opening `index.html` directly still runs the app — data saves to `localStorage` — but
install and offline support are off, since service workers don't register on `file://`.

## Installing it

Once served over http/localhost/https, an **Install** button appears in the header when the
browser offers installation (Chrome/Edge desktop and Android). On iOS Safari use
*Share → Add to Home Screen*. After the first load the app shell is cached, so it opens and
works with no network.

## Layout

    index.html      markup + PWA meta tags
    manifest.json   name, icons, colours, standalone display, "New project" shortcut
    sw.js           service worker: precaches the shell, caches fonts at runtime
    css/styles.css  all styling (dark + light themes via a data-theme attribute)
    js/storage.js   localStorage wrapper (the `Store` global)
    js/app.js       state, rendering, and all interaction
    icons/          PNG icons + SVG favicon
    tools/          icon generator (see below)

## Storage

Data lives in `localStorage` under the `projectLedger:` prefix — `projects` (the whole tree
as JSON) and `theme`. `js/storage.js` exposes that as `Store`, with a promise-based
`get`/`set` plus a synchronous pair used by the inline script in `index.html` that applies
the saved theme before first paint.

If `localStorage` is unavailable — private browsing, blocked cookies — `Store` falls back
to an in-memory map so nothing throws, the app stays usable for the session, and a toast
warns that changes won't be saved. `Store.persistent` tells you which mode you're in.

Everything is per-browser and per-origin; there is no sync or server. If the data grows
past a few MB, `Store` is the single place to swap in IndexedDB — nothing else in the app
touches storage.

## Service worker

`sw.js` precaches the shell listed in `SHELL` and serves it cache-first with a background
refresh. Navigations try the network first so updates land promptly, falling back to the
cached page when offline. Google Fonts are cached on first use.

**After changing any shell file, bump `VERSION` in `sw.js`.** Old caches are deleted on
activate, and clients pick up the new worker on next load. During development,
*DevTools → Application → Service Workers → Update on reload* avoids the wait.

## Icons

`icons/*.png` are generated — regenerate after editing the mark:

    python3 tools/make-icons.py icons

The script is pure standard library (writes PNGs via `zlib`), so it needs nothing installed.
`icons/favicon.svg` is hand-written and kept visually in sync.
