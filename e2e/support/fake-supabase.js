// Поддельный Supabase для e2e: вход через Telegram (Edge Function
// telegram-auth), Auth (getUser, refresh, logout) и PostgREST — ровно
// столько, сколько читают и пишут кабинет и мини-апп клиента (контент,
// заявка, свои записи клиента, cancel_own_booking, reschedule_own_booking).
//
// Подпись initData здесь НЕ проверяется — это UI-тесты. Настоящую проверку
// подписи гоняют e2e/unit (валидатор) и e2e/integration (функция + RLS на
// локальном Supabase). Поддельный initData — строка "e2e:<telegram id>".
//
// Тесты НИКОГДА не ходят в настоящий проект: в .env лежит боевая база
// мастера, и тестовые клиенты оказались бы в её «Клиентах». Поэтому
// dev-сервер для e2e собирается с VITE_SUPABASE_URL на домене .invalid
// (см. playwright.config.js), а всё, что не localhost и не этот адрес
// (telegram-web-app.js, Google Fonts), обрывается — как в браузере без
// сети, где window.Telegram и так undefined.

export const SUPABASE_URL = "https://e2e-project.supabase.invalid";
export const ANON_KEY = "e2e-anon-key";

// Мастер — роль 'master' выдана руками (schema.sql).
export const MASTER = {
  id: "00000000-0000-4000-8000-000000000001",
  telegramId: 1001,
  firstName: "Владислава",
  username: "vseees",
};
// Уже входивший клиент мини-аппа (роль 'user').
export const CLIENT = {
  id: "00000000-0000-4000-8000-000000000002",
  telegramId: 2002,
  firstName: "Анна",
  username: "anna_tg",
};

/** Поддельный initData для Telegram-пользователя — см. telegramStub(). */
export const initDataFor = (telegramId) => `e2e:${telegramId}`;

/**
 * window.Telegram.WebApp ровно настолько, насколько нужно для входа:
 * initData и initDataUnsafe.user, плюс ready/expand из init(). Без
 * openTelegramLink — чаты открываются через window.open, как в браузере.
 * Ставится через page.addInitScript до загрузки страницы.
 */
export function telegramStub(user, { initData } = {}) {
  return {
    initData: initData ?? initDataFor(user.telegramId),
    initDataUnsafe: {
      user: { id: user.telegramId, first_name: user.firstName, username: user.username },
    },
  };
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

// Похожий на настоящий JWT: auth-js может его разобрать, подпись никто не проверяет.
function fakeJwt(user, exp, sid) {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({
      sub: user.id,
      role: "authenticated",
      aud: "authenticated",
      exp,
      session_id: sid,
      app_metadata: { telegram_id: user.telegramId },
    }),
    // Валидный base64url: auth-js в setSession разбирает все три части.
    Buffer.from("e2e-signature").toString("base64url"),
  ].join(".");
}

function authUser(user) {
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: `tg${user.telegramId}@telegram.local`,
    app_metadata: { telegram_id: user.telegramId },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
}

/** Сессия, как её отдают telegram-auth и /auth/v1/token?grant_type=refresh_token. */
function sessionFor(user, sid) {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: fakeJwt(user, expiresAt, sid),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: `e2e-refresh-${sid}`,
  };
}

const profileRow = (u, role) => ({
  id: u.id,
  telegram_id: u.telegramId,
  role,
  first_name: u.firstName ?? "",
  last_name: "",
  telegram_username: u.username ?? "",
});

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
    // Роль мастера выдана руками (schema.sql); строки заводит telegram-auth
    // при первом входе, приложение их только читает.
    profiles: [profileRow(MASTER, "master"), profileRow(CLIENT, "user")],
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
 *  - users     — аккаунты ({ id, telegramId, firstName, username }), сюда же
 *    telegram-auth дописывает новых;
 *  - authCalls — тела каждого вызова telegram-auth;
 *  - logouts   — каждый /auth/v1/logout ({ scope, sid });
 *  - sessions  — выданные сессии (sid → user id); logout удаляет свою;
 *  - failBookingInsert — текст отказа guard_client_booking для вставки заявки
 *    (null — вставка проходит);
 *  - unhandled — запросы, которых подделка не знает (тест обязан упасть).
 */
export async function installFakeSupabase(page) {
  const state = {
    tables: seed(),
    users: [{ ...MASTER }, { ...CLIENT }],
    authCalls: [],
    logouts: [],
    sessions: new Map(),
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

function claims(req) {
  const token = (req.headers()["authorization"] ?? "").replace(/^Bearer /, "");
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
}

/** id вошедшего из Authorization: Bearer <fakeJwt>, или null (anon-ключ). */
const requester = (req) => claims(req).sub ?? null;

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
  const forbidden = () =>
    json(403, { code: "42501", message: "Нет доступа к этой записи", details: null, hint: null });

  // ─── Вход через Telegram (supabase/functions/telegram-auth) ─────
  //  Как настоящая функция: из тела берётся только initData, аккаунт
  //  ищется по telegram id, новому — роль 'user'. "e2e:expired" — подпись
  //  верна, но данные устарели; любое другое — неверные данные.
  if (url.pathname === "/functions/v1/telegram-auth" && method === "POST") {
    const body = req.postDataJSON() ?? {};
    state.authCalls.push(body);
    if (body.initData === "e2e:expired") return json(401, { error: "expired" });
    const tgId = Number(/^e2e:(\d+)$/.exec(body.initData ?? "")?.[1]);
    if (!tgId) return json(401, { error: "invalid_init_data" });

    let user = state.users.find((u) => u.telegramId === tgId);
    if (!user) {
      const n = String(state.nextId++).padStart(12, "0");
      user = { id: `00000000-0000-4000-8000-${n}`, telegramId: tgId, firstName: "Новый", username: "" };
      state.users.push(user);
      state.tables.profiles.push(profileRow(user, "user"));
    }
    const sid = `s${state.nextId++}`;
    state.sessions.set(sid, user.id);
    return json(200, sessionFor(user, sid));
  }

  // ─── Auth ───────────────────────────────────────────────────────
  if (url.pathname === "/auth/v1/user" && method === "GET") {
    const user = state.users.find((u) => u.id === requester(req));
    return user ? json(200, authUser(user)) : json(401, { code: 401, msg: "invalid JWT" });
  }
  if (url.pathname === "/auth/v1/token" && method === "POST") {
    const body = req.postDataJSON() ?? {};
    const sid = /^e2e-refresh-(.+)$/.exec(body.refresh_token ?? "")?.[1];
    const user = sid && state.users.find((u) => u.id === state.sessions.get(sid));
    if (url.searchParams.get("grant_type") !== "refresh_token" || !user) {
      return json(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
    }
    return json(200, { ...sessionFor(user, sid), user: authUser(user) });
  }
  if (url.pathname === "/auth/v1/logout" && method === "POST") {
    const sid = claims(req).session_id;
    state.logouts.push({ scope: url.searchParams.get("scope"), sid });
    state.sessions.delete(sid);
    return route.fulfill({ status: 204, headers: cors });
  }

  // ─── PostgREST ──────────────────────────────────────────────────
  const table = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1];
  const rows = table && state.tables[table];
  const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");

  // profiles: только чтение своей строки (.eq("id", …)), как RLS
  // profiles_select_own. Записи в profiles приложение не делает — любая
  // попытка уйдёт в unhandled и уронит тест.
  if (table === "profiles" && method === "GET") {
    const id = url.searchParams.get("id")?.replace(/^eq\./, "");
    return json(200, rows.filter((p) => p.id === id && p.id === requester(req)));
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
    // Как guard_client_booking(): длительность и цена — из services, имя
    // и юзернейм — из профиля, не от клиента; user_id — вошедший.
    const svc = state.tables.services?.find((s) => s.id === body.service_id);
    const prof = state.tables.profiles.find((p) => p.id === requester(req));
    const guarded = {
      ...(svc ? { duration: svc.duration, price: svc.price, service_name: svc.name } : {}),
      client_name: prof?.first_name ?? "",
      client_username: prof?.telegram_username ?? "",
    };
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
    const b = bookings.find((x) => x.id === body.p_id);
    // Чужая или несуществующая — 42501 (403), как в schema.sql.
    if (!b || b.user_id !== requester(req)) return forbidden();
    const open = b.status === "new" || b.status === "ok";
    if (open) Object.assign(b, { status: "cancelled", cancelled_by: "client", cancel_seen: false });
    return json(200, open);
  }
  if (rpc === "reschedule_own_booking" && method === "POST") {
    const body = req.postDataJSON();
    state.rpcs.push({ name: rpc, body });
    const b = bookings.find((x) => x.id === body.p_id);
    if (!b || b.user_id !== requester(req)) return forbidden();
    Object.assign(b, { day: body.p_day, start_min: body.p_start_min, status: "new", cancelled_by: "" });
    return json(200, wantsObject ? b : [b]);
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
