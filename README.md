# Anchor

An offline-first PWA for tracking software projects *and* recurring life maintenance —
car, home, health, finances, appliances, yard, digital admin — in one unified tree:
**domain → group → item → entry**. A plain static site with no build step and no
dependencies. (Started life as a Claude.ai artifact called Project Ledger, focused only
on software project tracking; the data model has since broadened to cover life
maintenance too, and the app renamed accordingly.)

Each **item** declares its own behavior:
- **one-off task** — a status (not started / in progress / blocked / done) plus an
  optional checklist, same as a traditional project task.
- **recurring** — a recurrence rule (interval, fixed calendar date, or a one-time
  reminder) plus a completion log, for things like "change the HVAC filter every 3
  months" or "oil change every 5,000 miles."

Domains, groups, and items all belong to a **category** (Software, Home, Car, Health,
Finance/Admin, Appliances, Yard, Digital/Admin) that drives which extra fields show up
(e.g. make/model/plate for a vehicle, address for a home) — see `CATEGORIES` in
`js/app.js`.

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
    manifest.json   name, icons, colours, standalone display, "New domain" shortcut
    sw.js           service worker: precaches the shell, caches fonts at runtime
    css/styles.css  all styling (dark + light themes via a data-theme attribute)
    js/storage.js   localStorage wrapper (the `Store` global)
    js/app.js       state, categories, recurrence engine, rendering, and all interaction
    icons/          PNG icons + SVG favicon
    tools/          icon generator (see below)

## Data model

    Domain   top-level container; has a fixed category (software/home/car/...)
      Group    optional sub-container — a specific vehicle/property/person, or a
               software epic. Items can also sit directly under a Domain.
        Item     kind:'task' (status + checklist) or kind:'recurring'
                 (recurrence rule + completion log). Due dates for recurring items
                 are always computed from the recurrence rule + latest log entry,
                 never stored, so there's nothing to keep in sync.

Reminders are in-app visual indicators only (overdue/due-soon badges) — there's no
push notification support, since this is a static site with no backend to trigger sends.

## Storage

Data lives in `localStorage` under the `projectLedger:` prefix (kept as-is internally —
renaming it would mean migrating the prefix itself, not just one key) — `domains` (the
whole tree as JSON) and `theme`. `js/storage.js` exposes that as `Store`, with a
promise-based `get`/`set` plus a synchronous pair used by the inline script in
`index.html` that applies the saved theme before first paint.

On first load, if no `domains` key exists yet but a legacy `projects` key does (from
the original Project Ledger release), `js/app.js` migrates it automatically: each old
project becomes a `category:'software'` domain, epics become groups, stories become
`kind:'task'` items, and any flat "quick tasks" become a synthetic "Quick tasks" item.
The legacy key is left untouched in case anything needs re-checking.

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
