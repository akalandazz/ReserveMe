// Интеграционные тесты входа и прав — против ЛОКАЛЬНОГО Supabase в Docker:
// настоящая Edge Function telegram-auth, настоящий PostgREST и RLS из
// supabase/schema.sql. Ничего из проверяемого не подделано: initData
// подписывается здесь тем же токеном, что лежит у функции в
// supabase/config.toml ([edge_runtime.secrets], ненастоящие токены).
//
// Как запустить:
//   npx supabase start -x studio,imgproxy,logflare,vector,realtime,storage-api,mailpit,postgres-meta,supavisor
//   npx supabase status -o env      → API_URL, ANON_KEY, SERVICE_ROLE_KEY
//   SUPABASE_IT_URL=… SUPABASE_IT_ANON_KEY=… SUPABASE_IT_SERVICE_KEY=… \
//     npx playwright test --project=integration
// Без этих переменных тесты пропускаются.
//
// ⚠️ Только локальный стек: тесты удаляют все записи и клиентов.
// Никогда не направляйте их на проект из .env.

import { createHmac, randomInt } from "node:crypto";

export const IT = {
  url: process.env.SUPABASE_IT_URL?.replace(/\/$/, "") ?? "",
  anon: process.env.SUPABASE_IT_ANON_KEY ?? "",
  service: process.env.SUPABASE_IT_SERVICE_KEY ?? "",
};
export const ENABLED = Boolean(IT.url && IT.anon && IT.service);
export const LOCAL_ONLY = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(IT.url);

// Те же, что в supabase/config.toml → [edge_runtime.secrets].
export const CLIENT_BOT = "111111:local-test-client-bot";
export const CABINET_BOT = "222222:local-test-cabinet-bot";

/** Новый Telegram-пользователь со случайным id — тесты не мешают прогонам. */
export function tgUser(name) {
  const id = 10_000_000 + randomInt(2_000_000_000);
  return { id, first_name: name, username: `${name.toLowerCase()}_${id}` };
}

/** initData, подписанный так, как это делает Telegram (HMAC-SHA256). */
export function signInitData(user, { token = CLIENT_BOT, authDate, extra = {} } = {}) {
  const fields = {
    auth_date: String(authDate ?? Math.floor(Date.now() / 1000) - 5),
    query_id: "AAE-integration",
    user: JSON.stringify(user),
    ...extra,
  };
  const dcs = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

/**
 * HTTP к локальному Supabase. token — access-токен пользователя; без него —
 * anon. key — apikey (anon или service). → { status, data }.
 */
export async function api(path, { method = "GET", token, body, key = IT.anon, headers = {} } = {}) {
  const res = await fetch(IT.url + path, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${token ?? key}`,
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/** Запрос от service role — только для подготовки и проверки состояния. */
export const admin = (path, opts = {}) => api(path, { ...opts, key: IT.service, token: IT.service });

/** Вход через Edge Function. body — дополнительные поля тела (их функция обязана игнорировать). */
export const login = (initData, body = {}) =>
  api("/functions/v1/telegram-auth", { method: "POST", body: { initData, ...body } });

/** Вошедший пользователь: { tg, token, refresh, uid }. */
export async function signIn(user, opts) {
  const res = await login(signInitData(user, opts));
  if (res.status !== 200) throw new Error(`login ${res.status}: ${JSON.stringify(res.data)}`);
  return {
    tg: user,
    token: res.data.access_token,
    refresh: res.data.refresh_token,
    uid: claims(res.data.access_token).sub,
  };
}

export function claims(jwt) {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
}

export const rpc = (name, args, token) =>
  api(`/rest/v1/rpc/${name}`, { method: "POST", body: args, token });

const RETURN_ROW = { prefer: "return=representation" };

/** Заявка клиента — так же, как её шлёт createBooking() в src/bookings.js. */
export const insertBooking = (token, fields) =>
  api("/rest/v1/bookings", {
    method: "POST",
    token,
    headers: RETURN_ROW,
    body: {
      start_min: 600,
      duration: 90,
      price: 50,
      service_id: "manicure",
      service_name: "Маникюр",
      comment: "",
      status: "new",
      source: "client",
      ...fields,
    },
  });

export const asRow = (res) => (Array.isArray(res.data) ? res.data[0] : res.data);

/** Строка bookings глазами service role. */
export async function bookingAsAdmin(id) {
  const res = await admin(`/rest/v1/bookings?id=eq.${id}&select=*`);
  return res.data[0];
}

/** Рабочие дни (пн–пт) в окне записи, по Тбилиси, начиная с послезавтра. */
export function workdays() {
  const out = [];
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tbilisi" });
  for (let i = 2; i <= 13; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    const key = fmt.format(d); // ГГГГ-ММ-ДД
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5 && !key.endsWith("-01-01") && !key.endsWith("-01-07")) out.push(key);
  }
  return out;
}

/** Чистая база записей перед прогоном (потолок заявок в час — общий на салон). */
export async function wipeBookings() {
  await admin("/rest/v1/client_comments?id=gt.0", { method: "DELETE" });
  await admin("/rest/v1/bookings?id=gt.0", { method: "DELETE" });
  await admin("/rest/v1/clients?id=gt.0", { method: "DELETE" });
}
