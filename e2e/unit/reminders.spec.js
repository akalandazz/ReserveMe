import { expect, test } from "@playwright/test";
import { createHandler } from "../../api/send-reminders.js";
import {
  dayLabel,
  deliverReminders,
  reminderMessage,
  runReminders,
  sendOutcome,
} from "../../supabase/functions/_shared/reminders.js";

// Напоминания о записи (supabase/functions/_shared/reminders.js) — текст
// сообщения и разбор ответов Telegram, тот же код, что исполняет
// Vercel-функция api/send-reminders.js. Сеть и база подменены функциями.

// Вторник, 20 октября 2026, 10:00 по Тбилиси (UTC+4).
const NOW = new Date("2026-10-20T06:00:00Z");

const row = (over = {}) => ({
  booking_id: 7,
  telegram_id: 4242,
  first_name: "Анна",
  day: "2026-10-21",
  start_min: 870,
  service_name: "Маникюр",
  master_name: "Владислава",
  address: "Тбилиси, ул. Пример, 12",
  landmark: "Домофон 5",
  ...over,
});

test("день — по календарю Тбилиси", () => {
  expect(dayLabel("2026-10-20", NOW)).toBe("сегодня");
  expect(dayLabel("2026-10-21", NOW)).toBe("завтра");
  expect(dayLabel("2026-10-22", NOW)).toBe("в четверг, 22 октября");
  expect(dayLabel("2026-10-27", NOW)).toBe("во вторник, 27 октября");
  expect(dayLabel("2026-10-28", NOW)).toBe("в среду, 28 октября");
  // 23:30 UTC 20-го — в Тбилиси уже 21-е: «завтра» сдвигается.
  expect(dayLabel("2026-10-22", new Date("2026-10-20T23:30:00Z"))).toBe("завтра");
});

test("сообщение: кому, когда, где; кнопка — только с https-адресом", () => {
  const body = reminderMessage(row(), { now: NOW, appUrl: "https://example.com/app" });
  expect(body.chat_id).toBe(4242);
  expect(body.text).toContain("Анна, ждём вас завтра в 14:30.");
  expect(body.text).toContain("💅 Маникюр");
  expect(body.text).toContain("📍 Тбилиси, ул. Пример, 12");
  expect(body.text).toContain("Домофон 5");
  expect(body.text).toContain("Владислава могла отдать время другому");
  expect(body).not.toHaveProperty("parse_mode");
  expect(body.reply_markup).toEqual({
    inline_keyboard: [[{ text: "Мои записи", web_app: { url: "https://example.com/app" } }]],
  });

  const bare = reminderMessage(row({ first_name: "", address: "", landmark: "" }), {
    now: NOW,
    appUrl: "http://insecure",
  });
  expect(bare.text).toContain("Ждём вас завтра в 14:30.");
  expect(bare.text).not.toContain("📍");
  expect(bare).not.toHaveProperty("reply_markup");
});

test("ответ Telegram → что делать с записью", () => {
  expect(sendOutcome(200)).toBe("sent");
  expect(sendOutcome(403)).toBe("unreachable");
  expect(sendOutcome(429)).toBe("retry");
  expect(sendOutcome(502)).toBe("retry");
  expect(sendOutcome(0)).toBe("retry");
  expect(sendOutcome(400)).toBe("drop");
});

/** Поддельные send/release/markUnreachable: статусы по очереди, вызовы — в журнал. */
function fakes(statuses) {
  const log = { sent: [], released: [], unreachable: [] };
  const queue = [...statuses];
  return {
    log,
    deps: {
      now: NOW,
      appUrl: "",
      send: async (body) => {
        log.sent.push(body.chat_id);
        const s = queue.shift();
        if (s instanceof Error) throw s;
        return s;
      },
      release: async (id) => log.released.push(id),
      markUnreachable: async (tgId) => log.unreachable.push(tgId),
    },
  };
}

test("доставка: 403 — клиент недоступен, сеть и 5xx — в очередь, 400 — пропуск", async () => {
  const rows = [
    row({ booking_id: 1, telegram_id: 11 }),
    row({ booking_id: 2, telegram_id: 22 }),
    row({ booking_id: 3, telegram_id: 33 }),
    row({ booking_id: 4, telegram_id: 44 }),
    row({ booking_id: 5, telegram_id: 55 }),
  ];
  const { log, deps } = fakes([200, 403, new Error("network"), 500, 400]);
  const counts = await deliverReminders(rows, deps);
  expect(counts).toEqual({ claimed: 5, sent: 1, unreachable: 1, retry: 2, drop: 1 });
  expect(log.sent).toEqual([11, 22, 33, 44, 55]);
  expect(log.unreachable).toEqual([22]);
  expect(log.released).toEqual([3, 4]);
});

test("доставка: 429 — остальное не шлём, всё в очередь", async () => {
  const rows = [1, 2, 3].map((id) => row({ booking_id: id, telegram_id: id * 10 }));
  const { log, deps } = fakes([429]);
  const counts = await deliverReminders(rows, deps);
  expect(log.sent).toEqual([10]);
  expect(log.released).toEqual([1, 2, 3]);
  expect(counts).toEqual({ claimed: 3, sent: 0, unreachable: 0, retry: 3, drop: 0 });
});

test("доставка: сбой release не роняет запуск", async () => {
  const { deps } = fakes([500, 200]);
  deps.release = async () => {
    throw new Error("db down");
  };
  const counts = await deliverReminders([row({ booking_id: 1 }), row({ booking_id: 2 })], deps);
  expect(counts).toMatchObject({ retry: 1, sent: 1 });
});

test("запуск: claim → отправка → release/mark через те же rpc", async () => {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push([name, args]);
    if (name === "claim_due_reminders") {
      return [row({ booking_id: 1, telegram_id: 11 }), row({ booking_id: 2, telegram_id: 22 })];
    }
    return null;
  };
  const statuses = [403, 502];
  const counts = await runReminders({ rpc, send: async () => statuses.shift(), now: NOW, batch: 7 });
  expect(counts).toEqual({ claimed: 2, sent: 0, unreachable: 1, retry: 1, drop: 0 });
  expect(calls).toEqual([
    ["claim_due_reminders", { p_limit: 7 }],
    ["mark_bot_unreachable", { p_telegram_id: 11 }],
    ["release_reminder", { p_id: 2 }],
  ]);
});

test("запуск: пустой claim (null) — ничего не шлём; сбой claim — наружу", async () => {
  const send = async () => {
    throw new Error("не должен слать");
  };
  expect(await runReminders({ rpc: async () => null, send, now: NOW })).toEqual({
    claimed: 0, sent: 0, unreachable: 0, retry: 0, drop: 0,
  });
  const failing = async () => {
    throw new Error("claim_due_reminders: 42501");
  };
  await expect(runReminders({ rpc: failing, send, now: NOW })).rejects.toThrow("42501");
});

test("Vercel-функция: без секрета — 401, без окружения — 500, PUT — 405", async () => {
  const env = {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    TELEGRAM_CLIENT_BOT_TOKEN: "1:bot",
    CRON_SECRET: "s3cret",
  };
  const handler = createHandler(env);
  const req = (headers = {}, method = "GET") =>
    new Request("http://localhost/api/send-reminders", { method, headers });

  expect((await handler(req())).status).toBe(401);
  expect((await handler(req({ authorization: "Bearer wrong" }))).status).toBe(401);
  expect((await handler(req({ authorization: "s3cret" }))).status).toBe(401);
  expect((await handler(req({ authorization: "Bearer s3cret" }, "PUT"))).status).toBe(405);

  const bare = createHandler({ ...env, CRON_SECRET: "" });
  const res = await bare(req({ authorization: "Bearer " }));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "not_configured" });
});
