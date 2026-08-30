# Anchor

An offline-first PWA for **household maintenance** — cars, home, appliances, health, admin —
built around one question: *what needs doing?*

A plain static site. No build step, no framework, no runtime dependencies. Data lives in the
browser; there is no account system and no backend.

> Anchor began in August 2026 as **Project Ledger**, a software project tracker, and was
> generalised to cover life maintenance before being rewritten from that base. The rewrite
> dropped software project tracking entirely, replaced the `Domain → Group → Item` tree with
> `Asset → Item`, and made the due queue the home screen. The reasoning is recorded as ADRs —
> see [Decisions](#decisions).

## The model

    Asset "2019 Honda CR-V"   (car, odometer 41,200)
      Item "Oil change"       every 5,000 miles
      Item "Registration"     every year on Mar 1
    Asset "123 Main St"       (home)
      Item "Clean gutters"    every 12 months
      Asset "Furnace"         (appliance)      ← assets nest
        Item "Filter"         every 3 months
    Asset "Ahad"              (person)
      Item "Physical"         every 12 months

**An asset is a thing you look after** — a car, a property, an appliance, a person, an account.
Assets nest, so a furnace lives inside a house. Its **category** is a property, not a level of
the tree, and it decides which extra fields the asset carries (make/plate/odometer for a car,
address for a home). Categories are defined in `CATEGORIES` in `js/model.js`; adding one is an
edit there rather than new code.

**An item is a thing with a schedule**, and there is only one kind of item. A schedule is:

- `interval` — every N days/weeks/months/years, or every N **miles**
- `fixed` — the same calendar date each year
- `once` — a one-off job, which is done as soon as anything is logged against it

**An entry is a completion**, appended to an item's log with an optional note, cost, and
odometer reading. Logging mileage updates the asset's odometer too, because that is one fact
rather than two.

Nothing about due state is stored. It is computed from the schedule plus the log on every
render, so there is no derived state to drift.

## Running it

ES modules do not load from `file://`, so the folder has to be served:

    python3 -m http.server 8000

then open <http://localhost:8000>. (`npx serve .` works too.)

Tests need no dependencies — node's built-in runner and `assert`:

    npm test

`package.json` exists only to say `"type": "module"` so node reads the `.js` files as ESM, and
to hold that one script. There is nothing to install and still no build step.

## Installing it

Served over https or localhost, the browser offers installation (Chrome/Edge desktop and
Android). On iOS Safari use *Share → Add to Home Screen*. After the first load the shell is
cached and it works with no network.

**On iOS an installed home-screen app is a separate storage origin from Safari**, even for the
same URL. Data entered in one does not appear in the other. This is the platform behaving as
designed, and it is the reason cross-device sharing needs a server at all.

## Layout

    index.html        markup, PWA meta, and the pre-paint theme read
    manifest.json     name, icons, colours, standalone display
    sw.js             service worker: precaches the shell
    css/styles.css    all styling; light + dark, phone-first
    js/schedule.js    when is an item next due — pure, DOM-free
    js/model.js       Asset → Item → Entry, tombstones, traversal
    js/storage.js     localStorage wrapper with an in-memory fallback
    js/persist.js     the bridge between bytes and shape
    js/timeline.js    grouping resolved items into buckets
    js/view.js        state → HTML strings; touches no DOM
    js/app.js         the only file that touches the DOM
    test/             node --test, no dependencies
    icons/            PNG icons + SVG favicon
    tools/            icon generator

The layering is deliberate and worth keeping: `model` imports `schedule`, `persist` imports
`storage` and `model`, and `view` is pure functions from state to strings. That last one is why
the markup is testable at all — `test/view.test.js` asserts on HTML without a browser.

`js/schedule.js` has no imports and no environment assumptions, so it can run inside a
Cloudflare Worker unchanged. That matters if push notifications are ever built: the server has
to compute due dates, and the alternative is a second implementation of the rules that must
agree with this one forever.

## Storage

Data lives in `localStorage` under the **`anchor:`** prefix — `state` (the whole tree as JSON)
and `theme`.

The old app's data is under `projectLedger:` and is deliberately **not** imported. It is left
untouched, so switching between the old and new versions on the same origin is non-destructive
in both directions.

If `localStorage` is unavailable — private browsing, blocked cookies — `Store` falls back to an
in-memory map so nothing throws and the session stays usable, and the app says plainly that
changes will not survive a reload. `Store.persistent` tells you which mode you are in.

If saved data cannot be parsed, it is copied to a timestamped `state.corrupt.<when>` key before
the app starts empty over it. Starting empty would otherwise destroy it on the next save.

`js/storage.js` is the only file that touches persistence, so it is also the only place to
change if the data ever outgrows `localStorage`.

## Soft deletes

**Nothing is ever removed from an array.** Every asset, item, and log entry carries `updatedAt`
and `deletedAt`; deleting sets a tombstone, and deleting an asset cascades tombstones to
everything inside it.

There is no sync layer yet, so this looks like ceremony for nothing. It is not. Sharing between
household members is a planned feature, and a merge added later cannot reconstruct deletions
that were implemented as removals — while doing it now costs nothing, because there is no data
to migrate. If you add code here, use `liveAssets` / `liveItems` / `liveLog` to read a
collection and never `splice`.

## Sharing

Not built. The model is designed for it and the machinery is deferred until the app has proven
it gets used — see ADR-0008.

A working prototype of the earlier, single-user design (a Cloudflare Worker plus one KV
namespace, keyed by a shared code) is preserved at the tag **`sync-prototype-v1`**. Its
`worker/` directory is unaffected by the model change and is the salvageable part:

    git checkout sync-prototype-v1 -- worker/

Reminders are in-app only. Push notifications are reachable later without a real backend — a
Worker cron trigger plus VAPID, with iOS supporting Web Push for home-screen-installed apps —
but the Worker would then need to compute due dates, which is what `js/schedule.js` being
portable is for.

## Service worker

`sw.js` precaches the shell listed in `SHELL` and serves it cache-first with a background
refresh. Navigations try the network first so updates land promptly, falling back to the cached
page when offline.

**After changing any shell file, bump `VERSION` in `sw.js`.** Every module is listed in `SHELL`
individually, so a new one must be added there too or the app will half-load offline. Old caches
are dropped on activate. During development, *DevTools → Application → Service Workers → Update
on reload* avoids the wait.

## Icons

`icons/*.png` are generated — regenerate after editing the mark:

    python3 tools/make-icons.py icons

The script is pure standard library (writes PNGs via `zlib`), so it needs nothing installed.
`icons/favicon.svg` is hand-written and kept visually in sync.

## Decisions

Architecture decisions live in the knowledge-vault at `projects/anchor/decisions/`. The ones
that explain why this code looks the way it does:

| | |
|---|---|
| **0002** | Compute due dates and health, never store them |
| **0003** | Read-first click-to-edit, over always-on forms |
| **0004** | Hash routing — Pages will not rewrite unknown paths, so real paths 404 |
| **0006** | Anchor is a household maintenance tracker; software tracking dropped |
| **0007** | Asset → Item, one nestable container type (supersedes 0001) |
| **0008** | Design for sharing, defer the machinery (supersedes 0005) |
| **0009** | A bucketed timeline as the home screen |
