// Уведомление мастеру о новой заявке клиента: текст сообщения бота.
//
// Обычный ESM без зависимостей, как reminders.js: его исполняет маршрут
// api/master-notify (Deno) и юнит-тест e2e/unit (Node). Сеть и база — в
// маршруте; здесь только то, что написать.
//
// Строка — из bookings, как её видит сам клиент (bookings_select_own):
//   { day: "ГГГГ-ММ-ДД", start_min, duration, price, service_name,
//     services: [{ name, duration, price }], comment, client_name,
//     client_username }
// Имя и юзернейм клиента в строку пишет сервер из проверенного профиля
// (guard_client_booking), а не из запроса.

import { dayLabel } from "./reminders.js";

// Тот же формат, что formatPrice() в src/money.js (юнит-тест сверяет):
// функции не видят src/, а цена в сообщении должна совпадать с экраном.
const fPrice = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** 2500 → "2 500 ₽" (неразрывные пробелы). Не число — пустая строка. */
export function formatPrice(n) {
  const v = Number(n);
  if (n == null || n === "" || !Number.isFinite(v)) return "";
  return `${fPrice.format(v)} ₽`;
}

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
// Как его принимает t.me: 5–32 символа.
const USERNAME = /^[A-Za-z0-9_]{5,32}$/;

/**
 * Тело sendMessage для мастера (без chat_id). Без parse_mode — ничего не
 * экранируем. Есть юзернейм клиента — под сообщением кнопка «Написать
 * клиенту».
 */
export function masterNotifyMessage(b, { now = new Date() } = {}) {
  const services = Array.isArray(b.services) ? b.services : [];
  const lines = ["🆕 Новая заявка", ""];
  if (services.length > 1) {
    lines.push("💅 Услуги:");
    for (const s of services) lines.push(`• ${s.name} — ${s.duration} мин, ${formatPrice(s.price)}`);
  } else {
    lines.push(`💅 ${b.service_name}`);
  }
  lines.push(
    `📅 ${dayLabel(b.day, now)} в ${hhmm(b.start_min)}`,
    `⏳ ${b.duration} мин · 💰 ${formatPrice(b.price)}`
  );
  if (b.comment) lines.push(`💬 ${b.comment}`);

  const username = USERNAME.test(b.client_username ?? "") ? b.client_username : "";
  const who = [b.client_name, username && `(@${username})`].filter(Boolean).join(" ");
  if (who) lines.push("", `👤 ${who}`);

  const body = { text: lines.join("\n"), disable_web_page_preview: true };
  if (username) {
    body.reply_markup = {
      inline_keyboard: [[{ text: "Написать клиенту", url: `https://t.me/${username}` }]],
    };
  }
  return body;
}
