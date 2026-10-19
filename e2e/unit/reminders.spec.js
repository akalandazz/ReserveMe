import { expect, test } from "@playwright/test";
import {
  dayLabel,
  deliverReminders,
  reminderMessage,
  sendOutcome,
} from "../../supabase/functions/_shared/reminders.js";

// Напоминания о записи (supabase/functions/_shared/reminders.js) — текст
// сообщения и разбор ответов Telegram, тот же код, что исполняет Edge
// Function send-reminders. Сеть и база подменены функциями.

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
