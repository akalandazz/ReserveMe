// Сообщения мастера клиенту — только для предпросмотра и «Скопировать»
// в листе записи. Кабинет никогда не открывает чат сам (openTelegramLink
// закрыл бы кабинет — см. CLAUDE.md): мастер отправляет текст сама, в тот
// канал, откуда клиент пишет. Шаблоны клиента мастеру — в src/telegram.js.

import { labelForKey, toHHMM } from "../schedule.js";

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function card({ serviceName, day, startMin, price }) {
  return `💅 ${serviceName}\n📅 ${labelForKey(day)}\n🕒 ${toHHMM(startMin)}\n💰 ${price} ₾`;
}

/**
 * kind: "new" — только что записала; "moved" — перенос (нужен was:
 * {day, startMin}); "updated" — поменялась услуга/комментарий/клиент;
 * "reminder" — ничего не менялось, просто напоминание.
 */
export function clientMessage({ kind, clientName, masterName, was, ...booking }) {
  const hi = `Здравствуйте, ${clientName}! 🌸\n`;
  const sign = masterName ? ` ${masterName}` : "";
  const body = card(booking);
  if (kind === "new") {
    return `${hi}Записала вас:\n\n${body}\n\nЕсли планы изменятся — напишите, пожалуйста.${sign}`;
  }
  if (kind === "moved") {
    return (
      `${hi}Ваша запись перенесена.\n\n` +
      `Было: ${lower(labelForKey(was.day))}, ${toHHMM(was.startMin)}\nСтало:\n${body}\n\n` +
      `Если время не подходит — напишите, подберём другое.${sign}`
    );
  }
  if (kind === "updated") return `${hi}Обновила вашу запись:\n\n${body}\n\nДо встречи!${sign}`;
  return `${hi}Напоминаю о записи:\n\n${body}\n\nДо встречи!${sign}`;
}
