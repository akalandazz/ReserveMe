// Поддельный Supabase для e2e: Auth (вход, регистрация, refresh) и PostgREST —
// ровно столько, сколько читают и пишут кабинет и мини-апп клиента
// (контент, заявка, свои записи клиента, cancel_own_booking).
//
// Тесты НИКОГДА не ходят в настоящий проект: в .env лежит боевая база
// мастера, и тестовые клиенты оказались бы в её «Клиентах». Поэтому
// dev-сервер для e2e собирается с VITE_SUPABASE_URL на домене .invalid
// (см. playwright.config.js), а всё, что не localhost и не этот адрес
// (telegram-web-app.js, Google Fonts), обрывается — как в браузере без
// сети, где window.Telegram и так undefined.

export const SUPABASE_URL = "https://e2e-project.supabase.invalid";
export const ANON_KEY = "e2e-anon-key";

export const MASTER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "master@e2e.test",
  password: "e2e-password",
};
// Уже зарегистрированный клиент мини-аппа (роль 'user').
export const CLIENT = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "client@e2e.test",
  password: "client-password",
};

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

// Похожий на настоящий JWT: auth-js может его разобрать, подпись никто не проверяет.
function fakeJwt(user, exp) {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", exp }),
    "e2e-signature",
  ].join(".");
}

/**
 * Ответ /auth/v1/token и /auth/v1/signup — он же сессия, которую auth-js
 * кладёт в localStorage (фикстура miniapp сеет её так, до загрузки).
 */
export function sessionFor(user) {
  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 3600;
  return {
    access_token: fakeJwt(user, expiresAt),
    token_type: "bearer",
    expires_in: 24 * 3600,
    expires_at: expiresAt,
    refresh_token: `e2e-refresh-${user.id}`,
    user: {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: "email" },
      user_metadata: {},
      identities: [{ provider: "email" }],
      created_at: "2026-01-01T00:00:00Z",
    },
  };
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
    // Роль мастера выдана руками (schema.sql); клиенту строку заводит
    // само приложение — ensureProfile в src/supabase.js.
    profiles: [{ id: MASTER.id, role: "master" }],
  };
}

/** Строка bookings — как её вернул бы select * (поля, которые читают кабинет и RPC). */
export function bookingRow(id, fields) {
  return {
    id,
    day: fields.day,
    start_min: fields.start_min ?? 600,
    duration: fields.duration ?? 90,
    price: fields.price ?? 60,
    service_id: fields.service_id ?? "manicure",
    service_name: fields.service_name || "Маникюр",
    client_id: null,
    client_name: fields.client_name ?? "Анна",
    client_username: fields.client_username ?? "",
    comment: "",
    status: fields.status ?? "new",
    source: fields.source ?? "client",
    user_id: fields.user_id ?? null,
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
 *  - users     — аккаунты Auth ({ id, email, password }), сюда же пишет signup;
 *  - failBookingInsert — текст отказа guard_client_booking для вставки заявки
 *    (null — вставка проходит);
 *  - profileWrites — каждая строка upsert в profiles ({ id, role });
 *  - unhandled — запросы, которых подделка не знает (тест обязан упасть).
 */
export async function installFakeSupabase(page) {
  const state = {
    tables: seed(),
    users: [{ ...MASTER }, { ...CLIENT }],
    profileWrites: [],
    inserts: [],
    changes: [],
    rpcs: [],
    failBookingInsert: null,
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

/** id вошедшего из Authorization: Bearer <fakeJwt>, или null (anon-ключ). */
function requester(req) {
  const token = (req.headers()["authorization"] ?? "").replace(/^Bearer /, "");
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub ?? null;
  } catch {
    return null;
  }
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
    const body = req.postDataJSON() ?? {};
    const user =
      url.searchParams.get("grant_type") === "refresh_token"
        ? state.users.find((u) => body.refresh_token === `e2e-refresh-${u.id}`)
        : state.users.find((u) => u.email === body.email && u.password === body.password);
    if (!user) {
      return json(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
    }
    return json(200, sessionFor(user));
  }
  // Регистрация — как с включённым «Auto Confirm»: сразу с сессией.
  if (url.pathname === "/auth/v1/signup" && method === "POST") {
    const { email, password } = req.postDataJSON() ?? {};
    if (state.users.some((u) => u.email === email)) {
      return json(422, { code: 422, error_code: "user_already_exists", msg: "User already registered" });
    }
    const n = String(state.nextId++).padStart(12, "0");
    const user = { id: `00000000-0000-4000-8000-${n}`, email, password };
    state.users.push(user);
    return json(200, sessionFor(user));
  }
  if (url.pathname === "/auth/v1/logout") return route.fulfill({ status: 204, headers: cors });

  // ─── PostgREST ──────────────────────────────────────────────────
  const table = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1];
  const rows = table && state.tables[table];
  const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");

  // profiles: чтение своей строки (.eq("id", …)) и upsert с
  // ignoreDuplicates — ON CONFLICT DO NOTHING, роль мастера не трогается.
  if (table === "profiles" && method === "GET") {
    const id = url.searchParams.get("id")?.replace(/^eq\./, "");
    return json(200, rows.filter((p) => p.id === id));
  }
  if (table === "profiles" && method === "POST") {
    const body = req.postDataJSON();
    // Не в inserts: их спеки считают вставки клиентов и заявок.
    state.profileWrites.push(...[].concat(body));
    for (const p of [].concat(body)) {
      if (!rows.some((r) => r.id === p.id)) rows.push({ id: p.id, role: p.role });
    }
    return route.fulfill({ status: 201, headers: cors });
  }

  // bookings — как RLS: мастер видит все строки, клиент — только свои
  // (bookings_select_own, user_id = auth.uid()).
  if (table === "bookings" && method === "GET" && requester(req) !== MASTER.id) {
    const uid = requester(req);
    return json(200, uid ? rows.filter((b) => b.user_id === uid) : []);
  }

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

  // Заявка клиента из мини-аппа (createBooking) — .select().single(),
  // в ответ строка целиком.
  if (table === "bookings" && method === "POST") {
    const body = req.postDataJSON();
    state.inserts.push({ table, body, headers: req.headers() });
    if (state.failBookingInsert) {
      return json(400, { code: "P0001", message: state.failBookingInsert, details: null, hint: null });
    }
    // Как guard_client_booking(): длительность и цена — из services, не от
    // клиента, user_id — вошедший.
    const svc = state.tables.services?.find((s) => s.id === body.service_id);
    const guarded = svc ? { duration: svc.duration, price: svc.price, service_name: svc.name } : {};
    const row = bookingRow(state.nextId++, { ...body, ...guarded, user_id: requester(req) });
    rows.push(row);
    return json(201, wantsObject ? row : [row]);
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
  if (rpc === "cancel_own_booking" && method === "POST") {
    const body = req.postDataJSON();
    state.rpcs.push({ name: rpc, body });
    const uid = requester(req);
    const b = bookings.find(
      (x) =>
        x.id === body.p_id && x.user_id === uid && (x.status === "new" || x.status === "ok")
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
