# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite dev server with HMR — serves both index.html and admin.html
npm run build    # production build to dist/ — two separate bundles, see "Two apps" below
npm run preview  # serve the built dist/
npm run lint     # oxlint (NOT eslint — config is .oxlintrc.json)
npm run e2e      # Playwright, e2e/ — PW_CHANNEL=msedge to use an installed browser
```

The only tests are Playwright e2e in `e2e/`. They run against their **own** Vite server
(port 5179) built with a fake `VITE_SUPABASE_URL`, and `e2e/support/fake-supabase.js`
answers Auth/PostgREST/RPC in the browser, for both `admin.html` (`cabinet` fixture)
and `index.html` (`miniapp` fixture) — never point them at the real project from
`.env`, it would write test clients into the master's base. The fake fails the test on
any request it doesn't handle; extend it when a new flow reads or writes a new table.

## Architecture

Two Telegram Mini Apps in one repo, one React 19 + Vite 8 codebase:

- **The client** (`index.html` → `src/main.jsx` → `src/App.jsx`) — where a customer
  browses services and submits a booking request. No login, no Supabase writes except
  a client's own new booking (see below).
- **The cabinet** (`admin.html` → `src/admin/main.jsx` → `src/admin/AdminApp.jsx`) —
  where the master signs in to manage her schedule, requests and prices. Completely
  separate bundle, separate CSS (`src/admin/admin.css`, not `src/index.css`), separate
  Telegram Mini App / bot menu button. **Never import client screens into `src/admin/`
  or vice versa** — see "Two apps" below for what's shared and what isn't.

Supabase holds salon content (services, prices, working hours, address, the «Важная
информация» blocks) so the master can edit it from the cabinet instead of editing code,
**and now also client bookings** — a deliberate change from the app's original design
(see "The delivery model" below for what that changed and what it didn't).

### The delivery model (the thing to understand first)

A booking is a *request*, never a confirmed appointment. When a client submits one:

1. It is persisted **client-side** via [src/storage.js](src/storage.js) — this remains
   the client's own source of truth for «Мои записи» and cancellation.
2. It is also inserted into Supabase's `bookings` table via
   [`submitBooking`](src/supabase.js) — **best-effort, with a short timeout**, so the
   cabinet has something to show. Its failure must never block or undo step 1 or 3.
3. [`sendToMaster`](src/telegram.js) opens `https://t.me/<логин мастера>?text=…`
   through `WebApp.openTelegramLink`, and the client sends the message themselves.

Consequences that constrain every change here:

- **`openTelegramLink` closes the Mini App.** Anything that must be saved is saved
  *before* the call — never after it, never in a `.then()` chained onto it. See
  `submit()` in [src/screens/BookingScreen.jsx](src/screens/BookingScreen.jsx).
- **`?text=` prefill is deep-link behavior, not a documented Mini App API**, and can
  silently fail. Every send screen therefore also renders the exact message in a
  `.msg-preview` block with a «Скопировать текст» fallback. Don't remove that.
- **A decision travels back, but only as a status — there is no push.** The master
  approves (`status` → `'ok'`) or declines/cancels (`'cancelled'`, `cancelled_by =
  'master'`) in the cabinet, and the client's copy lives in CloudStorage where the
  cabinet cannot reach it. The bridge is `client_token`: an unguessable uuid the
  client mints in `newClientToken()` ([src/storage.js](src/storage.js)), stores on its
  own record as `k`, and writes onto the server row.
  [`syncBookings()`](src/sync.js) calls the `booking_status(uuid[])` RPC on launch,
  on return to the tab (`App.jsx`), when «Мои записи» mounts and on each poll while home
  or «Мои записи» is open, caches the answer as
  `st` — plus the row's current `d`/`t`/`m`/`p`/`s`, because the master can move a
  booking or change its service without changing its status — and the change is shown
  as a toast — that toast is the client's only
  "notification". The same sync **re-sends** a request whose best-effort insert
  never provably landed (`sv !== true`; a duplicate `client_token` counts as landed).
  A missing row is read as a cancellation **only** when `sv === true`; otherwise it
  is re-sent, never read as a rejection.
- **Bookings from the Mini App are never hard-deleted by the cabinet.** «Отклонить»,
  the sheet's «Отменить запись» and the trash icon all go through `cancelBooking()`
  ([src/admin/api.js](src/admin/api.js)): a row with a `client_token` becomes
  `status = 'cancelled'`, one without (the master's own) is deleted as before. A client
  cancelling in «Мои записи» calls `cancel_own_booking(token)` **before**
  `sendToMaster`; the row becomes `cancelled`/`client` with `cancel_seen = false` and
  shows in «Заявки» → «Отмены» until the master taps «Понятно». There's no push toward
  the cabinet either: it polls `bookings` + `clients` every `VITE_ADMIN_POLL_SECONDS`
  (default 20) while visible
  (`pollAdminData()` in [src/admin/store.js](src/admin/store.js), skipped while a poll
  is in flight) and reloads them on return to the tab (`AdminApp.jsx`) — that's how new
  requests and client cancellations appear without a reload. Cancelled rows free
  the slot (`busy_slots`, `free_slots` skip them), can't be approved or edited, and
  `store.js` strips them from `bookings` in one place (`splitBookings`) — no section
  filters them itself.
- The client's slot list hides two things: *that client's own* stored bookings, from
  `src/storage.js`, **and** server-side busyness read from the `busy_slots` view —
  other clients' requests, bookings the master entered herself, and slots she closed
  by hand in the cabinet. The client still never reads the `bookings` table (RLS
  wouldn't let it — see below); `busy_slots` exposes day/start/duration only, no names.
  Two clients racing on the same slot is still possible — there is no reservation, only
  a read — but the window is now the seconds between two refreshes, not days. The
  master still resolves any collision by hand in the cabinet.
- **The cabinet opens a chat only with a Mini App client who has a Telegram username**
  (`canMessageClient()` in [src/admin/api.js](src/admin/api.js): `client_token` **and**
  `client_username`). After «Подтвердить»/«Отклонить» in «Заявки», a save in the sheet
  that confirms, moves or changes the service, the sheet's «Отменить запись» and the
  trash icon (upcoming bookings only), it calls `openChatWith(username, text)`
  ([src/telegram.js](src/telegram.js)) with the `clientMessage()` text
  ([src/admin/messages.js](src/admin/messages.js)) — the mirror image of `sendToMaster`.
  `openTelegramLink` usually **closes the cabinet**, so the same rule as the client's
  `submit()` applies: the write goes first, the chat opens only on `res.ok`, never in a
  `.then()` of it. Everyone else — the master's own bookings, clients without a username
  — gets the old toast and the sheet's preview + «Скопировать»; the cabinet never calls
  `sendToMaster` itself.

### Two apps: what's shared, what's isolated

| | Client (`src/`, `index.html`) | Cabinet (`src/admin/`, `admin.html`) |
|---|---|---|
| Auth | none (anonymous) | Supabase Auth sign-in |
| Reads | `settings`, `services`, `days_off`, `info_blocks`, `busy_slots` (public) | those, plus `bookings`, `blocked_slots`, `client_stats`, `client_comments`, `free_slots()` (auth only) |
| Writes | inserts its own row into `bookings` | everything, incl. its own confirmed bookings via `create_master_booking()` |
| CSS | `src/index.css` | `src/admin/admin.css` — its own token layer, duplicated on purpose |
| UI primitives | `src/ui.jsx` | `src/admin/components/Icons.jsx` — its own small icon set, duplicated on purpose |

Shared as plain imports (both apps use these as-is, no duplication):
[src/supabase.js](src/supabase.js), [src/theme.js](src/theme.js),
[src/telegram.js](src/telegram.js), and from [src/schedule.js](src/schedule.js) the
date/time helpers (`dateKey`, `toMinutes`, `toHHMM`, `labelForKey`) — but **not**
`buildSlots`/`buildDays`/`busyFor`, which are shaped around the client's per-service
CloudStorage bookings, not the cabinet's day/week/month calendar
([src/admin/calendar.js](src/admin/calendar.js) has the cabinet's own equivalents).

### Telegram integration

- The WebApp SDK is loaded from a `<script>` tag in **both** [index.html](index.html)
  and [admin.html](admin.html) — not as an npm dependency. It is reached only through
  the `window.Telegram.WebApp` global — no import, no types. Keep that script
  **synchronous and above** the module script in both files; that ordering is why
  `window.Telegram` exists at first render.
- `window.Telegram` is `undefined` in a normal browser. Every access is optional-chained
  and must stay that way, otherwise plain-browser development breaks — the cabinet in
  particular is routinely opened from a desktop browser, not just Telegram.
  [src/telegram.js](src/telegram.js) is the single wrapper — add new SDK usage there,
  gated by `atLeast("<version>")`, with a browser fallback.
- `BackButton` is wired in [src/App.jsx](src/App.jsx) as **three separate effects**:
  `onClick`/`offClick` subscription (once, `back` is a dependency-free `useCallback`),
  visibility keyed on `stack.length`, and a `hide()` on unmount. Merging them
  re-subscribes on every navigation and misbehaves under `React.StrictMode`. The cabinet
  has no BackButton wiring — it's a single scrolling page, not a stack.
- `initDataUnsafe` is unverified client data — fine for the greeting and for reading
  the client's name/username onto a new booking row. It is **not** an authorization
  signal anywhere: cabinet writes are gated by Supabase Auth + RLS, not by anything
  read from Telegram.

### Content, bookings and RLS

Salon content lives in four Supabase tables (`settings` — a single row, `services`,
`days_off`, `info_blocks`), plus two tables that exist only for the cabinet
(`bookings`, `blocked_slots`) and a view (`busy_slots`) that exposes availability
without personal data — the client reads that view, never `bookings` itself.
[supabase/schema.sql](supabase/schema.sql) is the schema and
seed, kept in the repo because the content is no longer in git otherwise.

- The anon key ships **inside the bundle** — that is expected. The security boundary is
  RLS. **Email signups must stay disabled in the Supabase dashboard**, otherwise anyone
  can register, become `authenticated`, and both rewrite the price list and read every
  client's name, phone and comment out of `bookings`.
- **`bookings` RLS is asymmetric, unlike every other table**: `anon` may only `insert`
  a row for itself (`status = 'new'`, `source = 'client'`, `day` no earlier than
  yesterday **in Tbilisi** — the database clock is UTC, and a client west of Tbilisi
  builds its day list from a device clock that's still on the Tbilisi "yesterday" —
  enforced by the insert policy's `with check`), never `select`. Only `authenticated`
  (the signed-in master) can read or change bookings. The client reads availability
  from the `busy_slots` view instead (day/start/duration only, no names), and its own
  request's status from the `booking_status(uuid[])` function — a `security definer`
  function that returns `status`, `cancelled_by` and the booking's own day/start/
  duration/price/service_id — never names, username or comment — and only for rows whose secret
  `client_token` the caller already knows. Both are the same trick: RLS is bypassed in
  one small place with a fixed column list. The anon row's contents are not trusted
  either: the `guard_client_booking()` trigger overwrites `duration`/`price`/
  `service_name` from `services`, bounds `day` to the booking window, rejects a start
  that isn't a real slot (day off, outside working hours, off the grid — the grid
  must stay in step with `buildSlots` in `schedule.js`), caps client requests at
  `max_per_hour` salon-wide (the anon key is public, and the client's identity is
  unverified, so there's no per-person key to limit by) and truncates the text
  fields — don't move those values back to "whatever the client sent". A rejection
  is invisible to the client (the insert is best-effort); the message still goes out.
  Every write policy (and every read on `bookings`/`clients`/`client_comments`) checks
  `public.is_master()`, not just the `authenticated` role, because Supabase's
  Anonymous Sign-ins also hand out `authenticated`; `security definer` master
  functions (`delete_client`) call it themselves. If you ever need more booking data on the
  client, widen that view or that function; **never** grant `anon` a `select` policy on
  `bookings` itself — it would hand every client's name, username and comment to
  anyone holding the (public) anon key.
- **Clients.** `clients` rows come from the `link_booking_client()` trigger (client
  requests, matched by username) and from the cabinet («Новый клиент», «Новая
  запись»). Bookings link to clients by `client_id`, **never by name**: `store.js`
  (`withClientNames`) overwrites each booking's `client_name`/`client_username` from
  its client, so a rename in «Клиенты» shows everywhere. The trigger never overwrites
  a non-empty client name, so a later request can't undo the master's rename.
  Comments live in `client_comments` (the old `clients.note` is migrated and unused).
  `client_stats` derives `visit_count`/`last_visit_at` from **past confirmed**
  bookings and `favorite_service_id` from all confirmed ones (`status = 'ok'` — an
  unhandled request is neither a visit nor a choice); it must stay
  `security_invoker = on`.
- **The master's own bookings** go through `create_master_booking()` (a new client
  plus a booking in one transaction, `status = 'ok'`, `source = 'master'` — never in
  «Заявки»). Start times come from `free_slots(day, service_id, exclude_id)` on the
  server (working hours, `days_off`, overlaps with bookings and blocked slots, not in
  the past, on the `slot_step_minutes` grid), and the per-day counts in the sheet's
  «Выберите день» step come from `free_slot_counts()`, which wraps the same function.
  `create_master_booking` re-checks under an advisory lock. The cabinet must never
  compute bookable times itself.
- **Editing any booking** (the day view's «Изменить», a request's «Изменить», a client's
  «Изменить» when they have an upcoming booking) goes through `update_master_booking()`:
  client data, a switch to another or a new client, service, day/time and comment in
  one transaction, and saving **always confirms** (`status → 'ok'`). Time is re-checked
  only when day, start or service changed, via `free_slots(…, p_id)` so the booking
  doesn't collide with itself. Same service keeps the row's agreed `price`/`duration`.
  «Подтвердить» in «Заявки» goes through `approve_booking()`, never a bare
  `update status = 'ok'`: two client requests for one slot are normal, two confirmed
  bookings are not. The `bookings_no_overlap_ok` exclusion constraint (`btree_gist`)
  backs that up at the table level for `status = 'ok'` rows only.
  The cabinet store reads `bookings`, `client_stats` and `client_comments` page by page
  (`selectAll` in `store.js`) — a plain select stops silently at PostgREST's
  `max_rows` (1000 on Supabase). It pages up to the server's `count`, not "until a
  short page", so a lower `max_rows` can't truncate it again.
  There is no separate approve/move/cancel UI in the day view anymore — that all lives
  in the sheet, next to the message the master copies for the client
  ([src/admin/messages.js](src/admin/messages.js)). The one exception is the trash
  icon (day view card, and each «Прошлые записи» row in «Клиенты»): it reminds nobody
  to message the client — unlike the sheet's «Отменить запись», which does — except
  that an upcoming Mini App booking with a username opens the chat (see above), and,
  like every cabinet cancel, it only hard-deletes rows without a `client_token`
  (see «Bookings from the Mini App are never hard-deleted» above). Its inline confirm, like the
  client-delete one, is gated by `confirmDel` in `AdminApp.jsx`: one open confirm
  across the whole cabinet.
- **Deleting a client** goes only through `delete_client(id)` (`security definer`,
  `authenticated` only): the client, **all** their bookings (past, upcoming, pending
  requests) and comments in one transaction, returning the deleted counts. `clients`
  has no delete policy on purpose, and `bookings.client_id` stays `on delete set null`
  — don't switch it to `cascade` to "simplify" this, and don't add a direct delete
  on `clients`: either would let a client vanish while leaving (or silently taking)
  bookings through some other path. A missing client returns zeros, not an error.
- `clients.channel` (`wa`/`ig`/`call`/`live`/`tg`, or `''`) records where a client the
  master registered herself writes from. It picks the contact link in «Клиенты» and the
  «Отправьте в …» hint; clients from Mini App requests leave it empty.
- [src/content.js](src/content.js) is the client's read-only store — fetch,
  `localStorage` cache, `useContent()`. It has **no mutation functions anymore**; all
  writes to salon content happen through [src/admin/api.js](src/admin/api.js) instead.
  It caches to `localStorage` (`vs_content_v1`), read **synchronously at module load**,
  so a returning client never sees the boot screen.
- Availability (`refreshBusy()`, the `busy` field) loads **separately** from the four
  content tables and is deliberately **not cached**: stale busyness is worse than none,
  since it would show an already-taken slot as free, and its failure must not blank a
  screen that only needs the price list.
- **The client always works on fresh data.** The `vs_content_v1` cache is for the first
  frame only. `refreshAll()` (content + availability, concurrent calls joined into one
  request) runs on launch, on **every screen change** (booking steps are screens) and
  whenever the tab becomes visible again (`App.jsx`) — a Mini App can sit open for hours
  while the master edits the schedule. `App.jsx` also polls every `VITE_CLIENT_POLL_SECONDS` (default 20; see
  `.env.example`) while visible:
  `refreshAll()` on every screen, `syncBookings()` only on home and «Мои записи» —
  the status toast lives on home, and a sync mid-booking would record the new status
  silently. `submit()` in `BookingScreen` re-reads both
  (2 s cap) **before** saving and before `sendToMaster`; if price, duration, the service
  itself, the day or the slot differs from what's on screen, it doesn't send and shows
  the fresh data instead — a warning the client already saw doesn't block. A timeout
  sends as before: the network never blocks a booking. When a refresh fails, `stale` is
  set and `<Screen>` shows the «данные могли устареть» note on every screen. Supabase
  requests from both apps bypass the HTTP cache (`cache: "no-store"` in `supabase.js`).
- `App.jsx` gates the whole client tree on `content.settings` — without it there is
  nothing to render, not even the crumb. There is no admin branch to check before that
  gate anymore: the cabinet is a different bundle at a different URL, so a broken
  client database can't lock the master out of the screen that fixes it.
- `createClient` (in `src/supabase.js`, shared by both apps) must keep
  `detectSessionInUrl: false` — Telegram opens the Mini App with a `#tgWebAppData=…`
  fragment that supabase-js would otherwise parse as an OAuth callback.

### Navigation

**Client**: screens are a stack in `useState` — no router. The booking steps
(`book:service` → `book:date` → `book:time` → `book:confirm`) are entries in that
stack, which is what makes BackButton walk the flow backwards for free. Going back
preserves the draft; only `home()` clears it. Changing the service resets
`draft.time`, because a slot valid for a 90-minute service may not exist for a
120-minute one.

**Cabinet**: no stack, no router — one scrolling page
([src/admin/AdminApp.jsx](src/admin/AdminApp.jsx)) that renders every section in order
(stats → requests → calendar → services → schedule). The only internal navigation state
is inside [CalendarSection.jsx](src/admin/components/CalendarSection.jsx) (which
month/week/day is showing) and each section's own edit-in-place state.

### Module boundaries

| File | Role |
|---|---|
| [src/content.js](src/content.js) | Client's read-only salon content: fetch, `localStorage` cache, plus uncached availability from the `busy_slots` view (`refreshBusy()`). Exposed through `useContent()` — a `useSyncExternalStore` store, the same idiom as `theme.js`. **`getSnapshot` must return a cached object**; building a fresh one per call is an infinite render loop. No mutations — those live in `src/admin/api.js`. Imports `dateKey` from `schedule.js`; the dependency only ever runs that way, never back. |
| [src/supabase.js](src/supabase.js) | Shared by both apps. Client + the master's session store (`useSession`, `signIn`, `signOut` — used only by the cabinet) + `submitBooking`, `fetchBookingStatuses` and `cancelOwnBooking` (used only by the client: a best-effort insert into `bookings`, the status read-back through the `booking_status` RPC, and `cancel_own_booking`). Every export must survive `supabase === null` (env vars unset). |
| [src/sync.js](src/sync.js) | Client-only. `syncBookings()` — the one place that reconciles stored bookings with their server rows (status read-back, re-sending unlanded requests), deduped by an in-flight promise because App and «Мои записи» both call it; `changesToast()` turns its result into the client's toast; `bookingRow()` builds the insert row for both `BookingScreen` and the re-send. |
| [src/schedule.js](src/schedule.js) | Pure date/slot functions, no React, no Telegram, no content import — settings arrive as a parameter (`buildDays(settings, daysOff)`, `buildSlots(day, service, busy, settings)`, `busyFor(bookings, key, settings)`, `serverBusyFor(busy, key, settings)`) and every function must survive `settings == null`. `busyFor` reads the client's own CloudStorage records, `serverBusyFor` the `busy_slots` rows; `BookingScreen` concatenates both before calling `buildSlots`, and a `busy_slots` row with `duration === 0` is a blocked slot one grid step long. **Never use `toISOString()`** to build a date key — it converts to UTC and shifts the day in Tbilisi (UTC+4). Client-only beyond the plain date helpers (see "Two apps"). |
| [src/storage.js](src/storage.js) | `CloudStorage` (gated on `isVersionAtLeast("6.9")`) mirrored onto `localStorage`. Every callback is promisified **with a 3s timeout** — some clients never fire it, which would hang «Мои записи» forever. Writes go to `localStorage` unconditionally. Client-only; the cabinet has no CloudStorage access to a client's device, which is why bookings also live in Supabase now. |
| [src/telegram.js](src/telegram.js) | SDK wrapper + the Russian message templates, shared by both apps. Reads the master's name and username from `contentSnapshot()` **inside each function**, never at module load. `sendToMaster`/`bookingMessage`/etc. are used by the client only — the cabinet must never call `sendToMaster`. |
| [src/theme.js](src/theme.js) | Light/dark resolution and the manual override, shared by both apps. No React. |
| [src/ui.jsx](src/ui.jsx) | Client-only presentational primitives. `<Screen>` owns the whole chrome — sticky crumb bar, toast slot, sticky footer. The footer is `position: sticky` inside a `100dvh` flex column, which is what keeps the last list row from hiding under the button without a padding hack. |
| [src/admin/store.js](src/admin/store.js) | Cabinet's data store — same `useSyncExternalStore` idiom as `content.js`, but reads `bookings`/`blocked_slots` too, and only after `useSession()` is `"signed"` (RLS blocks `anon` from `bookings` entirely). `resetAdminData()` clears it on sign-out. `loadAdminData(parts)` reloads only the named parts (keys of `LOADERS`; all of them by default, and always all while the snapshot isn't `"ready"`), each with its own stale-response counter. `pollAdminData()` re-reads `bookings`/`clients` on a timer while the tab is visible — the cabinet's only channel for client-side changes. |
| [src/admin/api.js](src/admin/api.js) | Every write the cabinet makes — services, `working_hours`, `days_off`, `blocked_slots`, `bookings`. Same `{ ok, error }`-never-throws idiom as the old `content.js` mutations, and every mutation reloads, on success, the store parts it may have changed (`run(query, parts)`). A new write must name everything it touches — e.g. a booking change also touches `clients`, because `client_stats` counts visits. |
| [src/admin/calendar.js](src/admin/calendar.js) | Cabinet's pure calendar math — month/week/day derivations from `bookings`/`blocked_slots`/`working_hours`. No React. Parallel to `schedule.js` but shaped for browsing any date, not just the client's next N bookable days. |
| [src/admin/components/](src/admin/components/) | One component per section of the cabinet page, plus `SignIn.jsx` and `Icons.jsx`. `CalendarSection.jsx` owns the month/week/day toggle and the selected date; `MonthGrid.jsx` wraps `react-day-picker` (custom `DayButton`, no default stylesheet — see `admin.css`); `WeekGrid.jsx` and `DayPanel.jsx` are hand-built, not calendar-library shaped. `BookingSheet.jsx` is the one bottom sheet for bookings and clients, in three modes: `new` (the 4-step «Записать» wizard — client → service → day → time → check, from the Расписание header or a client card), `edit` (an existing booking or request, opened on the check step) and `client` («Новый клиент», or «Изменить» on a client with no upcoming booking). It shows errors inline, because the cabinet's toast sits in page flow under the backdrop, and reports back through `onDone({ toast, day?, view?, clientId? })`. |

Stored bookings use short keys (`{id, s, d, t, m, p, c, k, st, sv}`) because CloudStorage
caps a value at 4096 characters — `k` is the `client_token` tying the record to its
server row, `st` the last known status (`"new"` / `"ok"` / `"cancelled"`), `sv`
whether the server row is known to exist (`true`; otherwise `syncBookings` re-sends
it). All three are absent on records
written before that channel existed, and every reader must tolerate that. `m` (duration) and `p` (price) are denormalized on purpose:
the master edits prices in the cabinet, and an old booking must keep showing what was
agreed. The `bookings` table denormalizes the same way (`duration`, `price`,
`service_name` columns) for the same reason, plus `service_id` can go `null` (`on
delete set null`) if the service is deleted outright — the cabinet's service editor
deletes for real, unlike the old admin's `active = false` hide.

## Conventions

- UI copy is Russian (`<html lang="ru">`); prices are Georgian lari (`₾`). Keep new
  strings in Russian, in both apps.
- Both [src/index.css](src/index.css) and [src/admin/admin.css](src/admin/admin.css)
  define **their own** token layer at the top of the file: warm neutral surfaces plus a
  single `--accent`, written out **twice** — once for light, once for dark
  (`html[data-theme="dark"]` and a `prefers-color-scheme` copy covering the first
  frame). The two files' tokens currently have the same values, but they are not the
  same file — a change to one's palette does not require changing the other's, and
  vice versa. Within each file, both copies must list the same tokens, and **below
  those blocks there must be no literal color** (`#ddd`, `white`, `#fff`) — that rule is
  what keeps dark theme working in that file. `--accent` is for accents, text-on-accent
  and the primary button; never for page or card surfaces.
- The palette is the app's own, not Telegram's: only safe-area comes from `--tg-*`.
  [src/theme.js](src/theme.js) sets `data-theme` on `<html>` from the client's
  `colorScheme` (system `prefers-color-scheme` in a browser), the header button
  overrides it into `localStorage`, and `syncChrome()` in `telegram.js` repaints the
  Telegram header/background to match — otherwise the seam around the Mini App is
  obvious. `initTheme()` guards against a second `onEvent("themeChanged")` subscription
  under `React.StrictMode`. Both apps call `initTheme()` independently and share the
  same `localStorage` key, so a manual theme choice made in one carries to the other.
- Fonts are Playfair Display (headings, prices) and Onest (everything else), loaded from
  Google Fonts in **both** [index.html](index.html) and [admin.html](admin.html), and
  reached through `--serif` / `--sans`, which carry system fallbacks for when the CDN
  is blocked.
- `viewport-fit=cover` in both HTML entry points is required, otherwise
  `env(safe-area-inset-*)` is 0 and a sticky footer sits under the home indicator.
- Neither app has an input primitive: forms use a raw `<input>`/`<textarea>` with
  `className="field"` and a `<label className="eyebrow" htmlFor>`. Native controls
  (`type="number"`, `time`, `date`, password reveal) theme themselves via `color-scheme`
  on `:root` — do not add `-webkit-appearance` hacks.
- The sign-in form (`src/admin/components/SignIn.jsx`, the cabinet's only gate) puts its
  button **in the body** as `<button className="btn-primary inline">` rather than in a
  sticky footer: with only two fields on screen, a sticky footer would sit right on top
  of the password field when the Telegram keyboard opens.
- `react-day-picker` (month grid in the cabinet) is themed with a fully custom
  `classNames`/`components` map in `MonthGrid.jsx` — **do not** import
  `react-day-picker/style.css`; it would bring in literal colors that don't track
  `data-theme`. All layout for its table markup lives in `admin.css` under the
  `.rdp-*` classes.
