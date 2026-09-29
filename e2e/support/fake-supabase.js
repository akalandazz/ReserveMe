// Поддельный Supabase для e2e: Auth (вход по паролю) и PostgREST —
// ровно столько, сколько читают и пишут кабинет и мини-апп клиента
// (контент, заявка, booking_status, cancel_own_booking).
//
// Тесты НИКОГДА не ходят в настоящий проект: в .env лежит боевая база
// мастера, и тестовые клиенты оказались бы в её «Клиентах». Поэтому
// dev-сервер для e2e собирается с VITE_SUPABASE_URL на домене .invalid
// (см. playwright.config.js), а всё, что не localhost и не этот адрес
// (telegram-web-app.js, Google Fonts), обрывается — как в браузере без
// сети, где window.Telegram и так undefined.

export const SUPABASE_URL = "https://e2e-project.supabase.invalid";
export const ANON_KEY = "e2e-anon-key";

export const MASTER = { email: "master@e2e.test", password: "e2e-password" };
const MASTER_ID = "00000000-0000-4000-8000-000000000001";

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

// Похожий на настоящий JWT: auth-js может его разобрать, подпись никто не проверяет.
function fakeJwt(exp) {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({ sub: MASTER_ID, email: MASTER.email, role: "authenticated", aud: "authenticated", exp }),
    "e2e-signature",
  ].join(".");
}

const HOURS = { from: "10:00", to: "19:00" };

function seed() {
  return {
    settings: [
      {
        id: 1,
        master_name: "Владислава",
        master_username: "vseees",
        slot_step_minutes: 30,
        booking_days_ahead: 14,
        working_hours: { 0: null, 1: HOURS, 2: HOURS, 3: HOURS, 4: HOURS, 5: HOURS, 6: HOURS },
      },
    ],
    services: [
      { id: "manicure", name: "Маникюр", price: 60, duration: 90, sort: 1, active: true },
    ],
    days_off: [],
    blocked_slots: [],
    bookings: [],
    client_stats: [],
    client_comments: [],
    // Только для мини-аппа клиента (content.js).
    info_blocks: [],
    busy_slots: [],
  };
}

/** Строка bookings — как её вернул бы select * (поля, которые читают кабинет и RPC). */
export function bookingRow(id, fields) {
  return {
    id,
    day: fields.day,
    start_min: fields.start_min ?? 600,
    duration: 90,
    price: 60,
    service_id: "manicure",
    service_name: "Маникюр",
    client_id: null,
    client_name: fields.client_name ?? "Анна",
    client_username: fields.client_username ?? "",
    comment: "",
    status: fields.status ?? "new",
    source: fields.source ?? "client",
    client_token: fields.client_token ?? null,
    cancelled_by: fields.cancelled_by ?? "",
    cancel_seen: fields.cancel_seen ?? false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** Строка client_stats для клиента без визитов — как её отдал бы view. */
export function clientRow(id, fields) {
  return {
    id,
    name: fields.name ?? "",
    telegram_username: fields.telegram_username ?? "",
    phone: fields.phone ?? "",
    channel: fields.channel ?? "",
    created_at: new Date().toISOString(),
    visit_count: 0,
    last_visit_at: null,
    favorite_service_id: null,
    favorite_service_name: null,
  };
}

/**
 * Ставит подделку на страницу. Возвращает живое состояние:
 *  - tables    — «база», её можно досеять до page.goto;
 *  - inserts   — каждая вставка в /rest/v1 ({ table, body, headers });
 *  - changes   — каждый PATCH/DELETE ({ method, table, id, body });
 *  - rpcs      — каждый вызов /rest/v1/rpc ({ name, body });
 *  - unhandled — запросы, которых подделка не знает (тест обязан упасть).
 */
export async function installFakeSupabase(page) {
  const state = {
    tables: seed(),
    inserts: [],
    changes: [],
    rpcs: [],
    unhandled: [],
    nextId: 100,
  };

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(SUPABASE_URL)) return handle(route, state);
    if (new URL(url).hostname === "localhost") return route.continue();
    return route.abort();
  });

  return state;
}

async function handle(route, state) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();

  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    // «*» не покрывает Authorization — отвечаем тем, что спросили.
    "access-control-allow-headers":
      req.headers()["access-control-request-headers"] ?? "authorization,apikey,content-type",
    // Без этого supabase-js не прочтёт count, и selectAll (store.js)
    // будет листать страницы до пустой.
    "access-control-expose-headers": "content-range",
  };
  const json = (status, body, extra = {}) =>
    route.fulfill({
      status,
      headers: { ...cors, "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    });

  if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });

  // ─── Auth ───────────────────────────────────────────────────────
  if (url.pathname === "/auth/v1/token" && method === "POST") {
    const { email, password } = req.postDataJSON() ?? {};
    if (email !== MASTER.email || password !== MASTER.password) {
      return json(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
    }
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return json(200, {
      access_token: fakeJwt(expiresAt),
      token_type: "bearer",
      expires_in: 3600,
      expires_at: expiresAt,
      refresh_token: "e2e-refresh-token",
      user: {
        id: MASTER_ID,
        aud: "authenticated",
        role: "authenticated",
        email: MASTER.email,
        app_metadata: { provider: "email" },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      },
    });
  }
  if (url.pathname === "/auth/v1/logout") return route.fulfill({ status: 204, headers: cors });

  // ─── PostgREST ──────────────────────────────────────────────────
  const table = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1];
  const rows = table && state.tables[table];
  const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");

  if (rows && method === "GET") {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? rows.length);
    const page = rows.slice(offset, offset + limit);
    if (wantsObject) return json(200, page[0] ?? null);
    const range = page.length ? `${offset}-${offset + page.length - 1}` : "*";
    return json(200, page, { "content-range": `${range}/${rows.length}` });
  }

  if (table === "clients" && method === "POST") {
    const body = req.postDataJSON();
    state.inserts.push({ table, body, headers: req.headers() });
    // Уникальный индекс clients_username_uq (schema.sql): непустой телеграм — один на клиента.
    const taken =
      body.telegram_username &&
      state.tables.client_stats.some((c) => c.telegram_username === body.telegram_username);
    if (taken) {
      return json(409, {
        code: "23505",
        message: 'duplicate key value violates unique constraint "clients_username_uq"',
        details: `Key (telegram_username)=(${body.telegram_username}) already exists.`,
        hint: null,
      });
    }
    const id = state.nextId++;
    // Клиент без визитов — сверху, как в порядке, которым читает store.js.
    state.tables.client_stats.unshift(clientRow(id, body));
    return json(201, wantsObject ? { id } : [{ id }]);
  }

  // Заявка клиента из мини-аппа (submitBooking) — return=minimal, без тела.
  if (table === "bookings" && method === "POST") {
    const body = req.postDataJSON();
    state.inserts.push({ table, body, headers: req.headers() });
    // Уникальный индекс bookings_client_token_uq.
    if (body.client_token && rows.some((b) => b.client_token === body.client_token)) {
      return json(409, {
        code: "23505",
        message: 'duplicate key value violates unique constraint "bookings_client_token_uq"',
        details: null,
        hint: null,
      });
    }
    rows.push(bookingRow(state.nextId++, body));
    return route.fulfill({ status: 201, headers: cors });
  }

  // update/delete из кабинета: всегда .eq("id", …).
  const eqId = Number(url.searchParams.get("id")?.replace(/^eq\./, ""));
  if (table === "bookings" && (method === "PATCH" || method === "DELETE") && eqId) {
    const body = method === "PATCH" ? req.postDataJSON() : null;
    state.changes.push({ method, table, id: eqId, body });
    const i = rows.findIndex((b) => b.id === eqId);
    if (i >= 0) {
      if (method === "PATCH") rows[i] = { ...rows[i], ...body };
      else rows.splice(i, 1);
    }
    return route.fulfill({ status: 204, headers: cors });
  }

  // ─── RPC мини-аппа (schema.sql) ─────────────────────────────────
  const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1];
  const bookings = state.tables.bookings;
  if (rpc === "booking_status" && method === "POST") {
    const body = req.postDataJSON();
    state.rpcs.push({ name: rpc, body });
    return json(
      200,
      bookings
        .filter((b) => b.client_token && body.p_tokens.includes(b.client_token))
        .map((b) => ({ client_token: b.client_token, status: b.status, cancelled_by: b.cancelled_by }))
    );
  }
  if (rpc === "cancel_own_booking" && method === "POST") {
    const body = req.postDataJSON();
    state.rpcs.push({ name: rpc, body });
    const b = bookings.find(
      (x) => x.client_token === body.p_token && (x.status === "new" || x.status === "ok")
    );
    if (b) Object.assign(b, { status: "cancelled", cancelled_by: "client", cancel_seen: false });
    return json(200, !!b);
  }

  // ─── RPC кабинета (schema.sql) — без перепроверок времени ───────
  if (rpc === "approve_booking" && method === "POST") {
    const body = req.postDataJSON();
    state.rpcs.push({ name: rpc, body });
    const b = bookings.find((x) => x.id === body.p_id);
    if (b) b.status = "ok";
    return json(200, null);
  }
  if (rpc === "update_master_booking" && method === "POST") {
    const body = req.postDataJSON();
    state.rpcs.push({ name: rpc, body });
    const b = bookings.find((x) => x.id === body.p_id);
    if (b) {
      Object.assign(b, {
        status: "ok",
        day: body.p_day,
        start_min: body.p_start_min,
        comment: body.p_comment,
      });
    }
    return json(200, null);
  }

  state.unhandled.push(`${method} ${url.pathname}${url.search}`);
  return json(501, { message: `e2e: fake Supabase does not handle ${method} ${url.pathname}` });
}
