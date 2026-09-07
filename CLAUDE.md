# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite dev server with HMR
npm run build    # production build to dist/
npm run preview  # serve the built dist/
npm run lint     # oxlint (NOT eslint — config is .oxlintrc.json)
```

There is no test setup in this project (no test runner, no test files).

## Architecture

A Telegram Mini App for booking appointments with a single beauty master, built as a
React 19 + Vite 8 single-page app.

Supabase holds **salon content only** — services, prices, working hours, address, the
«Важная информация» blocks — so the owner can edit them from the in-app admin screen
instead of editing code. **Client bookings never reach any server**, and that is a
deliberate constraint, not a gap. If you find yourself writing a booking into Supabase,
stop: it breaks the delivery model below.

### The delivery model (the thing to understand first)

A booking is a *request*, never a confirmed appointment. When a client submits one:

1. It is persisted **client-side only** via [src/storage.js](src/storage.js).
2. [`sendToMaster`](src/telegram.js) opens `https://t.me/<логин мастера>?text=…`
   through `WebApp.openTelegramLink`, and the client sends the message themselves.

Consequences that constrain every change here:

- **`openTelegramLink` closes the Mini App.** Anything that must be saved is saved
  *before* the call — never after it, never in a `.then()` chained onto it. See
  `submit()` in [src/screens/BookingScreen.jsx](src/screens/BookingScreen.jsx).
- **`?text=` prefill is deep-link behavior, not a documented Mini App API**, and can
  silently fail. Every send screen therefore also renders the exact message in a
  `.msg-preview` block with a «Скопировать текст» fallback. Don't remove that.
- The slot list hides only the *current user's own* stored bookings. It is not a
  shared calendar, and the UI copy must not imply that it is.

### Telegram integration

- The WebApp SDK is loaded from a `<script>` tag in [index.html](index.html), **not**
  as an npm dependency. It is reached only through the `window.Telegram.WebApp`
  global — no import, no types. Keep that script **synchronous and above** the module
  script; that ordering is why `window.Telegram` exists at first render.
- `window.Telegram` is `undefined` in a normal browser. Every access is optional-chained
  and must stay that way, otherwise plain-browser development breaks.
  [src/telegram.js](src/telegram.js) is the single wrapper — add new SDK usage there,
  gated by `atLeast("<version>")`, with a browser fallback.
- `BackButton` is wired in [src/App.jsx](src/App.jsx) as **three separate effects**:
  `onClick`/`offClick` subscription (once, `back` is a dependency-free `useCallback`),
  visibility keyed on `stack.length`, and a `hide()` on unmount. Merging them
  re-subscribes on every navigation and misbehaves under `React.StrictMode`.
- `initDataUnsafe` is unverified client data — fine for the greeting, and fine for the
  `?startapp=admin` deep link (it only opens a screen that then demands a password).
  It is **not** an authorization signal: admin writes are gated by Supabase Auth + RLS.

### Content and the admin screen

Salon content lives in four Supabase tables (`settings` — a single row, `services`,
`days_off`, `info_blocks`); [supabase/schema.sql](supabase/schema.sql) is the schema and
seed, kept in the repo because the content is no longer in git otherwise.

- The anon key ships **inside the bundle** — that is expected. The security boundary is
  RLS: anyone may `select`, only `authenticated` may write. **Email signups must stay
  disabled in the Supabase dashboard**, otherwise anyone can register, become
  `authenticated`, and rewrite the price list and the master's Telegram username.
- [src/content.js](src/content.js) is the runtime replacement for the old `src/data.js`.
  It caches to `localStorage` (`vs_content_v1`), read **synchronously at module load**, so
  a returning client never sees the boot screen.
- `App.jsx` gates the whole client tree on `content.settings` — without it there is
  nothing to render, not even the crumb. The admin branch is checked **before** that gate:
  an empty or unreachable database must not lock the owner out of the screen that fixes it.
- `createClient` must keep `detectSessionInUrl: false` — Telegram opens the Mini App with
  a `#tgWebAppData=…` fragment that supabase-js would otherwise parse as an OAuth callback.

### Navigation

Screens are a stack in `useState` — no router. The booking steps (`book:service` →
`book:date` → `book:time` → `book:confirm`) and the admin sections (`admin` →
`admin:services` → `admin:service`, …) are entries in that **same** stack, which is what
makes BackButton walk both flows backwards for free. Going back preserves the draft;
only `home()` clears it. Changing the service resets `draft.time`, because a slot valid
for a 90-minute service may not exist for a 120-minute one.

### Module boundaries

| File | Role |
|---|---|
| [src/content.js](src/content.js) | All salon content at runtime: fetch, `localStorage` cache, admin mutations, `slugify`/validation. Exposed through `useContent()` — a `useSyncExternalStore` store, the same idiom as `theme.js`. **`getSnapshot` must return a cached object**; building a fresh one per call is an infinite render loop. |
| [src/supabase.js](src/supabase.js) | Client + the session store (`useSession`, `signIn`, `signOut`). Every export must survive `supabase === null` (env vars unset). |
| [src/schedule.js](src/schedule.js) | Pure date/slot functions, no React, no Telegram, no content import — settings arrive as a parameter (`buildDays(settings, daysOff)`, `buildSlots(day, service, busy, settings)`, `busyFor(bookings, key, settings)`) and every function must survive `settings == null`. **Never use `toISOString()`** to build a date key — it converts to UTC and shifts the day in Tbilisi (UTC+4). |
| [src/storage.js](src/storage.js) | `CloudStorage` (gated on `isVersionAtLeast("6.9")`) mirrored onto `localStorage`. Every callback is promisified **with a 3s timeout** — some clients never fire it, which would hang «Мои записи» forever. Writes go to `localStorage` unconditionally. |
| [src/telegram.js](src/telegram.js) | SDK wrapper + the Russian message templates. Reads the master's name and username from `contentSnapshot()` **inside each function**, never at module load — they change at runtime now. |
| [src/theme.js](src/theme.js) | Light/dark resolution and the manual override. No React. |
| [src/ui.jsx](src/ui.jsx) | Presentational primitives. `<Screen>` owns the whole chrome — sticky crumb bar, toast slot, sticky footer. The footer is `position: sticky` inside a `100dvh` flex column, which is what keeps the last list row from hiding under the button without a padding hack. |
| [src/screens/admin/](src/screens/admin/) | The admin sections. The only nested screen folder — `AdminScreen.jsx` stays in `src/screens/` and dispatches into it, so one component instance spans every `admin:*` step and keeps its state. |

Stored bookings use short keys (`{id, s, d, t, m, p, c}`) because CloudStorage caps a
value at 4096 characters. `m` (duration) and `p` (price) are denormalized on purpose:
the owner edits prices in the admin screen, and an old booking must keep showing what was
agreed. Service `id`s are stable keys for those records — the admin UI makes the field
read-only after creation, and hiding a service (`active = false`) is the safe alternative
to deleting one, because a deleted service's name is gone from every past booking.

## Conventions

- UI copy is Russian (`<html lang="ru">`); prices are Georgian lari (`₾`). Keep new
  strings in Russian.
- [src/index.css](src/index.css) defines a token layer at the top of the file: warm
  neutral surfaces plus a single `--accent`, written out **twice** — once for light, once
  for dark (`html[data-theme="dark"]` and a `prefers-color-scheme` copy covering the
  first frame). Both copies must list the same tokens. **Below those blocks there must be
  no literal color** (`#ddd`, `white`, `#fff`) — that rule is what keeps dark theme
  working. `--accent` is for accents, text-on-accent and the primary button; never for
  page or card surfaces.
- The palette is the app's own, not Telegram's: only safe-area comes from `--tg-*`.
  [src/theme.js](src/theme.js) sets `data-theme` on `<html>` from the client's
  `colorScheme` (system `prefers-color-scheme` in a browser), the header button
  overrides it into `localStorage`, and `syncChrome()` in `telegram.js` repaints the
  Telegram header/background to match — otherwise the seam around the Mini App is
  obvious. `initTheme()` guards against a second `onEvent("themeChanged")` subscription
  under `React.StrictMode`.
- Fonts are Playfair Display (headings, prices) and Onest (everything else), loaded from
  Google Fonts in [index.html](index.html) and reached through `--serif` / `--sans`,
  which carry system fallbacks for when the CDN is blocked.
- `viewport-fit=cover` in [index.html](index.html) is required, otherwise
  `env(safe-area-inset-*)` is 0 and the sticky footer sits under the home indicator.
- There is no input primitive in `ui.jsx`: forms use a raw `<input>`/`<textarea>` with
  `className="field"` and a `<label className="eyebrow" htmlFor>`. Native controls
  (`type="number"`, `time`, `date`, password reveal) theme themselves via `color-scheme`
  on `:root` — do not add `-webkit-appearance` hacks.
- The sign-in form puts its button **in the body** as `<PrimaryButton inline>` rather than
  in `<Screen footer>`: with only two fields on screen the sticky footer would sit right
  on top of the password field when the Telegram keyboard opens. The longer admin forms
  keep «Сохранить» in the footer — if a field there turns out to be obscured on a real
  device, move that button inline too.
