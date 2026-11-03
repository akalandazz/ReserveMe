import { expect, test } from "@playwright/test";
import { formatPrice, masterNotifyMessage } from "../../supabase/functions/_shared/master-notify.js";
import { formatPrice as appFormatPrice } from "../../src/money.js";

// Уведомление мастеру о новой заявке (supabase/functions/_shared/master-notify.js)
// — тот же код, что исполняет маршрут api/master-notify. Bot API и база —
// e2e/integration/master-notify.spec.js.

// Вторник, 20 октября 2026, 10:00 по Тбилиси (UTC+4).
const NOW = new Date("2026-10-20T06:00:00Z");

const row = (over = {}) => ({
  day: "2026-10-21",
  start_min: 870,
  duration: 90,
  price: 2500,
  service_name: "Маникюр",
  services: [{ id: "manicure", name: "Маникюр", duration: 90, price: 2500 }],
  comment: "",
  client_name: "Анна",
  client_username: "anna_nails",
  ...over,
});

test("цена — как на экране приложения (src/money.js)", () => {
  for (const n of [0, 60, 2500, 99999, "1500", null, "", "abc"]) {
    expect(formatPrice(n)).toBe(appFormatPrice(n));
  }
});

test("одна услуга: день, время, длительность, цена, клиент", () => {
  const { text } = masterNotifyMessage(row(), { now: NOW });
  expect(text).toBe(
    [
      "🆕 Новая заявка",
      "",
      "💅 Маникюр",
      "📅 завтра в 14:30",
      `⏳ 90 мин · 💰 ${appFormatPrice(2500)}`,
      "",
      "👤 Анна (@anna_nails)",
    ].join("\n")
  );
});

test("несколько услуг — каждая своей строкой, итог общий; комментарий", () => {
  const { text } = masterNotifyMessage(
    row({
      duration: 180,
      price: 140,
      service_name: "Педикюр + Маникюр",
      services: [
        { id: "pedicure", name: "Педикюр", duration: 90, price: 80 },
        { id: "manicure", name: "Маникюр", duration: 90, price: 60 },
      ],
      comment: "приду с подругой",
      day: "2026-10-23",
    }),
    { now: NOW }
  );
  expect(text).toContain(
    `💅 Услуги:\n• Педикюр — 90 мин, ${appFormatPrice(80)}\n• Маникюр — 90 мин, ${appFormatPrice(60)}`
  );
  expect(text).toContain("📅 в пятницу, 23 октября в 14:30");
  expect(text).toContain(`⏳ 180 мин · 💰 ${appFormatPrice(140)}`);
  expect(text).toContain("💬 приду с подругой");
  expect(text).not.toContain("Педикюр + Маникюр");
});

test("кнопка «Написать клиенту» — только по юзернейму", () => {
  const body = masterNotifyMessage(row(), { now: NOW });
  expect(body.reply_markup.inline_keyboard).toEqual([
    [{ text: "Написать клиенту", url: "https://t.me/anna_nails" }],
  ]);
  expect(body).not.toHaveProperty("parse_mode");
  expect(body).not.toHaveProperty("chat_id");

  // Без юзернейма — без кнопок.
  const bare = masterNotifyMessage(row({ client_username: "" }), { now: NOW });
  expect(bare).not.toHaveProperty("reply_markup");
  expect(bare.text).toContain("👤 Анна");
  expect(bare.text).not.toContain("@");
});

test("кривой юзернейм не попадает ни в текст, ни в ссылку", () => {
  const body = masterNotifyMessage(row({ client_username: "x/../evil" }), { now: NOW });
  expect(body.text).not.toContain("evil");
  expect(body).not.toHaveProperty("reply_markup");
});

test("без имени и юзернейма — без строки клиента", () => {
  const { text } = masterNotifyMessage(row({ client_name: "", client_username: "" }), { now: NOW });
  expect(text).not.toContain("👤");
});
