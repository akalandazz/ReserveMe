// Сообщения мастера клиенту. Клиенту из мини-аппа с Telegram-логином
// кабинет сам открывает чат с готовым текстом (notifyClient) — после
// того, как изменение уже сохранено: openTelegramLink обычно закрывает
// кабинет. Остальным — предпросмотр и «Скопировать» в листе записи,
// мастер отправляет сама, в тот канал, откуда клиент пишет.
// Шаблоны клиента мастеру — в src/telegram.js.

import { formatPrice } from "../money.js";
import { labelForKey, toHHMM } from "../schedule.js";
import { openChatWith } from "../telegram.js";
import { canMessageClient } from "./api.js";

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function card({ serviceName, day, startMin, price }) {
  return `💅 ${serviceName}\n📅 ${labelForKey(day)}\n🕒 ${toHHMM(startMin)}\n💰 ${formatPrice(price)}`;
}

/**
 * kind: "new" — только что записала; "approved" — подтвердила заявку;
 * "moved" — перенос (нужен was: {day, startMin}); "updated" — поменялась
 * услуга/комментарий/клиент; "declined" — отклонила заявку; "cancelled" —
 * отменила подтверждённую запись; "reminder" — просто напоминание.
 */
export function clientMessage({ kind, clientName, masterName, was, ...booking }) {
  const hi = clientName ? `Здравствуйте, ${clientName}! 🌸\n` : "Здравствуйте! 🌸\n";
  const sign = masterName ? ` ${masterName}` : "";
  const body = card(booking);
  if (kind === "new") {
    return `${hi}Записала вас:\n\n${body}\n\nЕсли планы изменятся — напишите, пожалуйста.${sign}`;
  }
  if (kind === "approved") {
    return `${hi}Подтверждаю вашу запись:\n\n${body}\n\nДо встречи!${sign}`;
  }
  if (kind === "moved") {
    return (
      `${hi}Ваша запись перенесена.\n\n` +
      `Было: ${lower(labelForKey(was.day))}, ${toHHMM(was.startMin)}\nСтало:\n${body}\n\n` +
      `Если время не подходит — напишите, подберём другое.${sign}`
    );
  }
  if (kind === "declined") {
    return (
      `${hi}К сожалению, не получится записать вас на это время:\n\n${body}\n\n` +
      `Напишите, пожалуйста, — подберём другое.${sign}`
    );
  }
  if (kind === "cancelled") {
    return (
      `${hi}К сожалению, вашу запись пришлось отменить:\n\n${body}\n\n` +
      `Напишите, пожалуйста, — подберём другое время.${sign}`
    );
  }
  if (kind === "updated") return `${hi}Обновила вашу запись:\n\n${body}\n\nДо встречи!${sign}`;
  return `${hi}Напоминаю о записи:\n\n${body}\n\nДо встречи!${sign}`;
}

/**
 * Приглашение в приложение для клиента, которому бот ещё не может писать:
 * ссылка на бота с кодом (botInviteLink в api.js) и предстоящие записи
 * карточки ([{ day, start_min, service_name }]). По «Запустить» бот сам
 * пришлёт приглашение с кнопками «Принять» / «Отклонить».
 */
export function inviteMessage({ clientName, masterName, link, bookings = [] }) {
  const hi = clientName ? `Здравствуйте, ${clientName}! 🌸\n` : "Здравствуйте! 🌸\n";
  const sign = masterName ? `\n\n${masterName}` : "";
  const list = bookings
    .map((b) => `📅 ${labelForKey(b.day)}, ${toHHMM(b.start_min)} — ${b.service_name}`)
    .join("\n");
  return (
    `${hi}Ваши записи ко мне теперь можно смотреть в приложении — там же их легко ` +
    `перенести или отменить, а бот напомнит о визите.` +
    (list ? `\n\n${list}` : "") +
    `\n\nОткройте ссылку и нажмите «Запустить» — бот пришлёт приглашение:\n${link}${sign}`
  );
}

/** Отказ или отмена — по тому, была ли запись уже подтверждена. */
export const dropKind = (row) => (row.status === "new" ? "declined" : "cancelled");

/**
 * Открывает чат с клиентом из мини-аппа с сообщением об изменении строки
 * bookings. Вызывать только ПОСЛЕ успешной записи в базу. Возвращает
 * false и ничего не открывает, если написать некому (см. canMessageClient).
 */
export function notifyClient(row, kind, masterName) {
  if (!canMessageClient(row)) return false;
  openChatWith(
    row.client_username,
    clientMessage({
      kind,
      clientName: row.client_name,
      masterName,
      serviceName: row.service_name,
      day: row.day,
      startMin: row.start_min,
      price: row.price,
    })
  );
  return true;
}
