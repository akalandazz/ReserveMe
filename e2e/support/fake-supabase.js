// Поддельный Supabase для e2e: Auth (вход по паролю) и PostgREST —
// ровно столько, сколько читает и пишет кабинет.
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
        slot_step_minutes: 30,
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
 *  - inserts   — каждая запись в /rest/v1 ({ table, body, headers });
 *  - unhandled — запросы, которых подделка не знает (тест обязан упасть).
 */
export async function installFakeSupabase(page) {
  const state = { tables: seed(), inserts: [], unhandled: [], nextId: 100 };

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

  state.unhandled.push(`${method} ${url.pathname}${url.search}`);
  return json(501, { message: `e2e: fake Supabase does not handle ${method} ${url.pathname}` });
}
