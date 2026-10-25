import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import {
  CLIENT_BOT,
  ENABLED,
  IT,
  LOCAL_ONLY,
  admin,
  api,
  asRow,
  bookingAsAdmin,
  login,
  rpc,
  signIn,
  signInitData,
  tgUser,
  wipeBookings,
} from "./support.js";

// Напоминания о записи на локальном Supabase: claim_due_reminders() и
// соседи из supabase/schema.sql, set_reminders() под RLS и настоящая Edge
// Function api/reminders. Bot API подменён HTTP-сервером на хосте:
// функция в Docker ходит на TELEGRAM_API_URL из supabase/config.toml
// (host.docker.internal:54399).

test.skip(!ENABLED, "нет SUPABASE_IT_* — локальный Supabase не поднят (см. support.js)");
test.skip(ENABLED && !LOCAL_ONLY, "SUPABASE_IT_URL должен указывать на локальный стек");

const CRON_SECRET = "local-test-cron-secret"; // supabase/config.toml
const BOT_PORT = 54399;
// Функция без результата: PostgREST отвечает 204 (старые версии — 200).
const VOID_OK = [200, 204];

let A, B; // клиенты мини-аппа

/** { day, start_min } через hoursAhead часов по Тбилиси, на 5-минутной сетке. */
function tbilisiSlot(hoursAhead) {
  const at = new Date(Date.now() + hoursAhead * 3_600_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tbilisi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  const min = Number(parts.hour) * 60 + Number(parts.minute);
  return { day: `${parts.year}-${parts.month}-${parts.day}`, start_min: min - (min % 5) };
}

/** Запись, как её завела бы мастер клиенту мини-аппа — мимо RPC, от service role. */
async function booking(user, hoursAhead, fields = {}) {
  const res = await admin("/rest/v1/bookings", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: {
      ...tbilisiSlot(hoursAhead),
      duration: 30,
      price: 50,
      service_id: "manicure",
      service_name: "Маникюр",
      status: "ok",
      source: "master",
      user_id: user?.uid ?? null,
      // у service role нет салона — default current_salon_id() пуст
      salon_id: 1,
      ...fields,
    },
  });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return asRow(res);
}

const claim = (limit = 50) => rpc("claim_due_reminders", { p_limit: limit }, IT.service);
const profileOf = async (user) =>
  (await admin(`/rest/v1/profiles?id=eq.${user.uid}&select=reminders,bot_unreachable_at`)).data[0];
const setHours = (h) =>
  admin("/rest/v1/settings?salon_id=eq.1", { method: "PATCH", body: { reminder_hours: h } });

test.beforeAll(async () => {
  if (!ENABLED || !LOCAL_ONLY) return;
  A = await signIn(tgUser("Rita"));
  B = await signIn(tgUser("Boris"));
});

test.beforeEach(async () => {
  if (!ENABLED || !LOCAL_ONLY) return;
  await wipeBookings();
  await setHours(24);
  for (const u of [A, B]) {
    await admin(`/rest/v1/profiles?id=eq.${u.uid}`, {
      method: "PATCH",
      body: { reminders: true, bot_unreachable_at: null },
    });
  }
});

test.afterAll(async () => {
  if (ENABLED && LOCAL_ONLY) await setHours(24);
});

test.describe("claim_due_reminders", () => {
  test("берёт только подтверждённые записи клиентов в окне — и только один раз", async () => {
    const due = await booking(A, 3);
    await booking(A, 5, { status: "new" }); // заявка — время не согласовано
    await booking(A, 30); // дальше окна в 24 часа
    await booking(A, 0.25); // меньше чем через полчаса — поздно
    await booking(null, 7); // клиент мастера, без аккаунта
    await booking(A, 9, { status: "cancelled", cancelled_by: "master" });

    const first = await claim();
    expect(first.status).toBe(200);
    expect(first.data).toHaveLength(1);
    expect(first.data[0]).toMatchObject({
      booking_id: due.id,
      telegram_id: A.tg.id,
      first_name: "Rita",
      day: due.day,
      start_min: due.start_min,
      service_name: "Маникюр",
    });
    expect(first.data[0].master_name).toBeTruthy();
    expect((await bookingAsAdmin(due.id)).reminded_at).not.toBeNull();

    // Второй запуск ту же запись не берёт.
    expect((await claim()).data).toEqual([]);
  });

  test("перенос сбрасывает отметку, другие правки — нет", async () => {
    const b = await booking(A, 3);
    expect((await claim()).data).toHaveLength(1);

    await admin(`/rest/v1/bookings?id=eq.${b.id}`, { method: "PATCH", body: { comment: "кофе" } });
    expect((await bookingAsAdmin(b.id)).reminded_at).not.toBeNull();

    await admin(`/rest/v1/bookings?id=eq.${b.id}`, { method: "PATCH", body: tbilisiSlot(4) });
    expect((await bookingAsAdmin(b.id)).reminded_at).toBeNull();
    expect((await claim()).data.map((r) => r.booking_id)).toEqual([b.id]);
  });

  test("release_reminder возвращает запись в очередь", async () => {
    const b = await booking(A, 3);
    expect((await claim()).data).toHaveLength(1);
    expect(VOID_OK).toContain((await rpc("release_reminder", { p_id: b.id }, IT.service)).status);
    expect((await claim()).data.map((r) => r.booking_id)).toEqual([b.id]);
  });

  test("окно — settings.reminder_hours; 0 — салон не напоминает", async () => {
    await booking(A, 30);
    expect((await claim()).data).toEqual([]);
    await setHours(48);
    expect((await claim()).data).toHaveLength(1);

    await booking(A, 3);
    await setHours(0);
    expect((await claim()).data).toEqual([]);
  });

  test("выключил клиент или бот недоступен — не берёт", async () => {
    await booking(A, 3);
    await booking(B, 4);
    expect((await rpc("set_reminders", { p_enabled: false }, A.token)).data).toBe(false);
    expect(VOID_OK).toContain(
      (await rpc("mark_bot_unreachable", { p_telegram_id: B.tg.id }, IT.service)).status
    );
    expect((await claim()).data).toEqual([]);

    // Включил снова — заодно снимает «бот недоступен» (разрешил боту писать).
    await admin(`/rest/v1/profiles?id=eq.${A.uid}`, {
      method: "PATCH",
      body: { bot_unreachable_at: new Date().toISOString() },
    });
    expect((await rpc("set_reminders", { p_enabled: true }, A.token)).data).toBe(true);
    expect(await profileOf(A)).toMatchObject({ reminders: true, bot_unreachable_at: null });
    expect((await claim()).data.map((r) => r.telegram_id)).toEqual([A.tg.id]);
  });
});

test.describe("права", () => {
  test("клиент и аноним не вызывают служебные функции", async () => {
    for (const [name, args] of [
      ["claim_due_reminders", { p_limit: 5 }],
      ["release_reminder", { p_id: 1 }],
      ["mark_bot_unreachable", { p_telegram_id: B.tg.id }],
    ]) {
      expect([401, 403], `${name} клиентом`).toContain((await rpc(name, args, A.token)).status);
      expect([401, 403], `${name} анонимом`).toContain((await rpc(name, args)).status);
    }
    expect((await profileOf(B)).bot_unreachable_at).toBeNull();
  });

  test("set_reminders меняет только свою строку; анониму — 401", async () => {
    expect((await rpc("set_reminders", { p_enabled: false })).status).toBe(401);
    expect((await rpc("set_reminders", { p_enabled: false }, A.token)).status).toBe(200);
    expect((await profileOf(A)).reminders).toBe(false);
    expect((await profileOf(B)).reminders).toBe(true);
    // Писать в profiles напрямую клиенту по-прежнему нельзя.
    const direct = await api(`/rest/v1/profiles?id=eq.${A.uid}`, {
      method: "PATCH",
      token: A.token,
      body: { reminders: true },
    });
    expect([401, 403]).toContain(direct.status);
  });

  test("вход с allows_write_to_pm снимает «бот недоступен»", async () => {
    await admin(`/rest/v1/profiles?id=eq.${A.uid}`, {
      method: "PATCH",
      body: { bot_unreachable_at: new Date().toISOString() },
    });
    // Без разрешения в initData отметка остаётся.
    expect((await login(signInitData(A.tg))).status).toBe(200);
    expect((await profileOf(A)).bot_unreachable_at).not.toBeNull();

    expect((await login(signInitData({ ...A.tg, allows_write_to_pm: true }))).status).toBe(200);
    expect((await profileOf(A)).bot_unreachable_at).toBeNull();
  });
});

test.describe("Edge Function api/reminders", () => {
  /** Поддельный Bot API: ответ по chat_id, все запросы — в журнал. */
  let server;
  const calls = [];
  const statusFor = new Map();

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
  });

  test.afterAll(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  });

  const run = (secret = CRON_SECRET) =>
    api("/functions/v1/api/reminders", {
      method: "POST",
      headers: secret === null ? {} : { "x-cron-secret": secret },
      body: {},
    });

  test("без секрета или с чужим — 401, ничего не берёт", async () => {
    const b = await booking(A, 3);
    expect((await run(null)).status).toBe(401);
    expect((await run("wrong")).status).toBe(401);
    expect((await bookingAsAdmin(b.id)).reminded_at).toBeNull();
  });

  test("шлёт от бота клиента; 403 — клиент недоступен, 5xx — запись в очереди", async () => {
    calls.length = 0;
    statusFor.clear();
    const ok = await booking(A, 3);
    const blocked = await booking(B, 4);
    statusFor.set(B.tg.id, 403);

    const res = await run();
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data).toMatchObject({ claimed: 2, sent: 1, unreachable: 1, retry: 0 });

    expect(calls.map((c) => c.path)).toEqual([
      `/bot${CLIENT_BOT}/sendMessage`,
      `/bot${CLIENT_BOT}/sendMessage`,
    ]);
    const toA = calls.find((c) => c.body.chat_id === A.tg.id).body;
    expect(toA.text).toContain("Rita, ждём вас");
    expect(toA.text).toContain("💅 Маникюр");
    // Мини-апп салона этой записи.
    expect(toA.reply_markup.inline_keyboard[0][0].web_app.url).toBe(
      "https://example.invalid/miniapp?salon=main"
    );
    expect((await bookingAsAdmin(ok.id)).reminded_at).not.toBeNull();
    expect((await profileOf(B)).bot_unreachable_at).not.toBeNull();
    expect((await bookingAsAdmin(blocked.id)).reminded_at).not.toBeNull();

    // Временная ошибка Telegram — запись возвращается в очередь.
    calls.length = 0;
    const later = await booking(A, 6);
    statusFor.set(A.tg.id, 502);
    expect((await run()).data).toMatchObject({ claimed: 1, retry: 1 });
    expect((await bookingAsAdmin(later.id)).reminded_at).toBeNull();

    statusFor.set(A.tg.id, 200);
    expect((await run()).data).toMatchObject({ claimed: 1, sent: 1 });
    expect((await bookingAsAdmin(later.id)).reminded_at).not.toBeNull();
  });
});
