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
React 19 + Vite 8 single-page app. **There is no backend, no API, and no database** —
that is a deliberate constraint, not a gap.

### The delivery model (the thing to understand first)

A booking is a *request*, never a confirmed appointment. When a client submits one:

1. It is persisted **client-side only** via [src/storage.js](src/storage.js).
2. [`sendToMaster`](src/telegram.js) opens `https://t.me/<MASTER_USERNAME>?text=…`
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
- `initDataUnsafe` is unverified client data — fine for the greeting. If a booking ever
  reaches a backend, it must send `initData` for server-side signature validation.

### Navigation

Screens are a stack in `useState` — no router. The booking steps (`book:service` →
`book:date` → `book:time` → `book:confirm`) are entries in that **same** stack, which is
what makes BackButton walk the flow backwards for free. Going back preserves the draft;
only `home()` clears it. Changing the service resets `draft.time`, because a slot valid
for a 90-minute service may not exist for a 120-minute one.

### Module boundaries

| File | Role |
|---|---|
| [src/data.js](src/data.js) | **All** salon content. Written for a non-programmer to edit — keep logic out of it. Service `id`s are stable keys for stored bookings; never rename them. `MASTER_USERNAME` is the one value that can come from the environment (`VITE_MASTER_USERNAME`, defaulting to the literal in the file); Vite inlines it at build time, so `.env` changes need a rebuild like every other edit here. |
| [src/schedule.js](src/schedule.js) | Pure date/slot functions, no React, no Telegram. **Never use `toISOString()`** to build a date key — it converts to UTC and shifts the day in Tbilisi (UTC+4). |
| [src/storage.js](src/storage.js) | `CloudStorage` (gated on `isVersionAtLeast("6.9")`) mirrored onto `localStorage`. Every callback is promisified **with a 3s timeout** — some clients never fire it, which would hang «Мои записи» forever. Writes go to `localStorage` unconditionally. |
| [src/telegram.js](src/telegram.js) | SDK wrapper + the Russian message templates. |
| [src/theme.js](src/theme.js) | Light/dark resolution and the manual override. No React. |
| [src/ui.jsx](src/ui.jsx) | Presentational primitives. `<Screen>` owns the whole chrome — sticky crumb bar, toast slot, sticky footer. The footer is `position: sticky` inside a `100dvh` flex column, which is what keeps the last list row from hiding under the button without a padding hack. |

Stored bookings use short keys (`{id, s, d, t, m, p, c}`) because CloudStorage caps a
value at 4096 characters. `m` (duration) and `p` (price) are denormalized on purpose:
the owner edits prices in `data.js`, and an old booking must keep showing what was agreed.

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
- This directory is not a git repository.
