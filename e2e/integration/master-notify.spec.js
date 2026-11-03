import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import {
  CABINET_BOT,
  ENABLED,
  LOCAL_ONLY,
  admin,
  api,
  asRow,
  insertBooking,
  signIn,
  tgUser,
  wipeBookings,
  workdays,
} from "./support.js";

// Уведомление мастеру о новой заявке — настоящий маршрут api/master-notify
// (supabase/functions/api/master-notify.ts): строка читается от имени
// клиента (RLS bookings_select_own), пишет бот кабинета салона каждому его
// мастеру. Bot API подменён HTTP-сервером на хосте (TELEGRAM_API_URL в
// supabase/config.toml). Ничего в базе не хранит.

test.skip(!ENABLED, "нет SUPABASE_IT_* — локальный Supabase не поднят (см. support.js)");
test.skip(ENABLED && !LOCAL_ONLY, "SUPABASE_IT_URL должен указывать на локальный стек");

const BOT_PORT = 54399;
const DAY = workdays()[0];

let M, A, B; // мастер салона 1 и два клиента
let server;
const calls = [];
const statusFor = new Map();
const sentTo = (chatId) => calls.filter((c) => c.body.chat_id === chatId);

const notify = (bookingId, token) =>
  api("/functions/v1/api/master-notify", { method: "POST", token, body: { booking_id: bookingId } });

let start = 600;
/** Заявка клиента, как её шлёт createBooking() — каждый раз новое окошко. */
async function request(who, fields = {}) {
  const res = await insertBooking(who.token, {
    day: DAY,
    start_min: start,
    services: [{ id: "manicure" }],
    comment: "приду с подругой",
    ...fields,
  });
  start += 120;
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return asRow(res);
}

test.beforeAll(async () => {
  if (!ENABLED || !LOCAL_ONLY) return;
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      calls.push({ path: req.url, body });
      const status = statusFor.get(body.chat_id) ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status === 200 }));
    });
  });
  await new Promise((resolve) => server.listen(BOT_PORT, "0.0.0.0", resolve));
  await wipeBookings();

  const mUser = tgUser("NotifyMaster");
  await signIn(mUser);
  await admin(`/rest/v1/profiles?telegram_id=eq.${mUser.id}`, { method: "PATCH", body: { role: "master" } });
  M = await signIn(mUser);
  A = await signIn(tgUser("Alisa"));
  B = await signIn(tgUser("Boris"));
});

test.afterAll(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

test.beforeEach(() => {
  calls.length = 0;
  statusFor.clear();
});

test("своя свежая заявка — бот кабинета пишет мастеру, один раз", async () => {
  const b = await request(A);
  const res = await notify(b.id, A.token);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  expect(res.data).toEqual({ sent: true });

  const [msg] = sentTo(M.tg.id);
  expect(msg.path).toBe(`/bot${CABINET_BOT}/sendMessage`);
  expect(msg.body.text).toContain("🆕 Новая заявка");
  expect(msg.body.text).toContain("💅 Маникюр");
  expect(msg.body.text).toContain("💬 приду с подругой");
  // Имя и юзернейм — из проверенного профиля клиента, не из запроса.
  expect(msg.body.text).toContain(`👤 Alisa (@${A.tg.username})`);
  expect(msg.body.reply_markup.inline_keyboard).toEqual([
    [{ text: "Написать клиенту", url: `https://t.me/${A.tg.username}` }],
  ]);
  // Клиенту бот ничего не пишет.
  expect(sentTo(A.tg.id)).toEqual([]);

  // Повтор с тем же id — мастеру второй раз не пишем.
  expect((await notify(b.id, A.token)).data).toEqual({ sent: false });
  expect(sentTo(M.tg.id)).toHaveLength(1);
});

test("пишет только мастерам салона заявки", async () => {
  const b = await request(A);
  await notify(b.id, A.token);
  const masters = await admin("/rest/v1/profiles?role=eq.master&salon_id=eq.1&select=telegram_id");
  const ours = new Set(masters.data.map((p) => p.telegram_id));
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) expect(ours.has(c.body.chat_id)).toBe(true);
});

test("чужая заявка, без входа, кривой id — ничего не уходит", async () => {
  const b = await request(A);
  expect((await notify(b.id, B.token)).status).toBe(404);
  expect((await notify(999_999_999, A.token)).status).toBe(404);
  expect([401, 404]).toContain((await notify(b.id)).status); // anon
  expect((await notify("1", A.token)).status).toBe(400);
  const noAuth = await api("/functions/v1/api/master-notify", {
    method: "POST",
    headers: { authorization: "" },
    body: { booking_id: b.id },
  });
  expect(noAuth.status).toBe(401);
  expect(calls).toEqual([]);
});

test("не свежая или уже подтверждённая — не пишем", async () => {
  const old = await request(A);
  await admin(`/rest/v1/bookings?id=eq.${old.id}`, {
    method: "PATCH",
    body: { created_at: new Date(Date.now() - 10 * 60_000).toISOString() },
  });
  expect((await notify(old.id, A.token)).data).toEqual({ sent: false });

  const approved = await request(A);
  await admin(`/rest/v1/bookings?id=eq.${approved.id}`, { method: "PATCH", body: { status: "ok" } });
  expect((await notify(approved.id, A.token)).data).toEqual({ sent: false });

  expect(calls).toEqual([]);
});

test("мастер не разрешила боту писать (403) — ответ 200, заявка на месте", async () => {
  statusFor.set(M.tg.id, 403);
  const b = await request(B);
  const res = await notify(b.id, B.token);
  expect(res.status).toBe(200);
  // Другие мастера салона 1 (из прошлых прогонов) могли и получить — важно,
  // что отказ одного не ломает ответ и заявку.
  expect(sentTo(M.tg.id)).toHaveLength(1);
  const row = await admin(`/rest/v1/bookings?id=eq.${b.id}&select=status`);
  expect(row.data[0].status).toBe("new");
});
