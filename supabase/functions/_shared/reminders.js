// Напоминания о записи: текст сообщения и цикл отправки.
//
// Обычный ESM без зависимостей, как telegram-init-data.js: его исполняет
// Vercel-функция api/send-reminders.js и тесты e2e/unit, e2e/integration
// (Node). Сеть и база приходят параметрами (rpc/send) — здесь только
// решения: что написать и что делать с ответом Telegram.
//
// Строки — из claim_due_reminders() (supabase/schema.sql):
//   { booking_id, telegram_id, first_name, day: "ГГГГ-ММ-ДД", start_min,
//     service_name, master_name, address, landmark }
// day/start_min — тбилисские дата и минуты, как везде в базе.

const TZ = "Asia/Tbilisi";
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу"];
const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/** Сегодняшняя дата в Тбилиси, "ГГГГ-ММ-ДД". */
export function tbilisiToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
}

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** "сегодня" | "завтра" | "в среду, 22 октября" — по тбилисскому календарю. */
export function dayLabel(day, now = new Date()) {
  const [y, m, d] = day.split("-").map(Number);
  const date = Date.UTC(y, m - 1, d);
  const [ty, tm, td] = tbilisiToday(now).split("-").map(Number);
  const diff = Math.round((date - Date.UTC(ty, tm - 1, td)) / 86_400_000);
  if (diff === 0) return "сегодня";
  if (diff === 1) return "завтра";
  const dow = new Date(date).getUTCDay();
  // «во вторник», но «в среду».
  return `${dow === 2 ? "во" : "в"} ${WEEKDAYS[dow]}, ${d} ${MONTHS[m - 1]}`;
}

/**
 * Тело sendMessage для одной записи. Без parse_mode — ничего не
 * экранируем, имя и адрес уходят как есть. appUrl — ссылка мини-аппа
 * (https), тогда под сообщением кнопка «Мои записи».
 */
export function reminderMessage(r, { now = new Date(), appUrl = "" } = {}) {
  const hello = r.first_name ? `${r.first_name}, ждём` : "Ждём";
  const lines = [
    "🔔 Напоминание о записи",
    "",
    `${hello} вас ${dayLabel(r.day, now)} в ${hhmm(r.start_min)}.`,
    `💅 ${r.service_name}`,
  ];
  if (r.address) lines.push(`📍 ${r.address}`);
  if (r.landmark) lines.push(r.landmark);
  lines.push(
    "",
    "Если планы изменились — перенесите или отмените запись в приложении" +
      (r.master_name ? `, чтобы ${r.master_name} могла отдать время другому.` : ".")
  );
  const body = { chat_id: r.telegram_id, text: lines.join("\n"), disable_web_page_preview: true };
  if (/^https:\/\//.test(appUrl ?? "")) {
    body.reply_markup = { inline_keyboard: [[{ text: "Мои записи", web_app: { url: appUrl } }]] };
  }
  return body;
}

/**
 * Что делать с ответом Telegram:
 *   "sent"        — дошло;
 *   "unreachable" — 403: бот заблокирован или писать ему не разрешали;
 *   "retry"       — сеть, 429, 5xx: вернуть запись в очередь;
 *   "drop"        — прочие 4xx (неверный chat_id и т. п.): повтор не поможет.
 * status 0 — запрос не дошёл до Telegram.
 */
export function sendOutcome(status) {
  if (status >= 200 && status < 300) return "sent";
  if (status === 403) return "unreachable";
  if (status === 0 || status === 429 || status >= 500) return "retry";
  return "drop";
}

/**
 * Отправить напоминания по очереди.
 *   send(body) → HTTP-статус ответа Telegram (0 — не дошло);
 *   release(bookingId) — вернуть запись в очередь;
 *   markUnreachable(telegramId) — не писать этому клиенту, пока не разрешит.
 * На 429 остальное не шлём — всё оставшееся тоже в очередь, Telegram
 * просит подождать. Ничего не бросает наружу: ошибка одной записи — её
 * "retry", не всего запуска.
 */
export async function deliverReminders(rows, { send, release, markUnreachable, now, appUrl }) {
  const counts = { claimed: rows.length, sent: 0, unreachable: 0, retry: 0, drop: 0 };
  const quietly = async (fn) => {
    try {
      await fn();
    } catch {
      // запись останется отмеченной — лучше пропустить напоминание, чем слать дважды
    }
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let status = 0;
    try {
      status = await send(reminderMessage(r, { now, appUrl }));
    } catch {
      status = 0;
    }
    const outcome = sendOutcome(status);
    counts[outcome]++;
    if (outcome === "unreachable") await quietly(() => markUnreachable(r.telegram_id));
    if (outcome === "retry") await quietly(() => release(r.booking_id));
    if (status === 429) {
      for (const rest of rows.slice(i + 1)) {
        counts.retry++;
        await quietly(() => release(rest.booking_id));
      }
      break;
    }
  }
  return counts;
}

/**
 * Один запуск: claim_due_reminders() → deliverReminders.
 *   rpc(name, args) → данные ответа; бросает при ошибке базы;
 *   send(body) → HTTP-статус Telegram, как у deliverReminders.
 * Ошибка claim уходит наружу — запуск не состоялся, записи не тронуты.
 */
export async function runReminders({ rpc, send, now = new Date(), appUrl = "", batch = 50 }) {
  const rows = (await rpc("claim_due_reminders", { p_limit: batch })) ?? [];
  return deliverReminders(rows, {
    send,
    release: (id) => rpc("release_reminder", { p_id: id }),
    markUnreachable: (tgId) => rpc("mark_bot_unreachable", { p_telegram_id: tgId }),
    now,
    appUrl,
  });
}
