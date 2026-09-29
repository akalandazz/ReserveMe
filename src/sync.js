// Своя запись клиента ↔ её строка в bookings.
//
// Локальная копия (src/storage.js) — источник правды для «Мои записи»,
// но решения мастера живут только на сервере. syncBookings() сводит их:
//  - подтягивает статус ("ok" / "cancelled") через booking_status();
//  - досылает заявку, чей best-effort insert при записи не доехал
//    (sv !== true): openTelegramLink закрывает мини-апп сразу после
//    submitBooking, и медленный запрос мог оборваться — мастер тогда не
//    видела заявку в кабинете, а клиент — подтверждения;
//  - возвращает изменения, чтобы экран показал их клиенту тостом.
//
// Ни одна ошибка сети не меняет статус: пропавшая строка значит «отменена»,
// только если мы точно знаем, что она была в базе (sv === true).

import { isPast, labelForKey, toMinutes } from "./schedule.js";
import { loadBookings, saveBookings } from "./storage.js";
import { fetchBookingStatuses, submitBooking } from "./supabase.js";
import { tgUser } from "./telegram.js";

/** Колонки bookings для заявки из локальной записи. Длительность, цену
 *  и название сервер всё равно перезапишет из services (guard_client_booking). */
export function bookingRow(record, serviceName = "") {
  const u = tgUser();
  return {
    day: record.d,
    start_min: toMinutes(record.t),
    duration: record.m,
    price: record.p,
    service_id: record.s,
    service_name: serviceName,
    client_name: u ? [u.first_name, u.last_name].filter(Boolean).join(" ") : "",
    client_username: u?.username ?? "",
    comment: record.c ?? "",
    client_token: record.k,
  };
}

// Главная, «Мои записи» и возврат во вкладку могут позвать синхронизацию
// одновременно — две параллельные записи в хранилище затёрли бы друг друга.
let inflight = null;

/**
 * @returns {Promise<{ list: object[], changes: object[] }>} list — записи
 *   после синхронизации (уже сохранённые); changes — записи, чей статус
 *   только что стал "ok" или "cancelled" (для тоста).
 */
export function syncBookings() {
  if (!inflight) {
    inflight = run().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function run() {
  const list = await loadBookings();
  // Записи без токена (старые версии, вебвью без crypto) спросить нечем;
  // прошедшие и уже отменённые — незачем.
  const tracked = list.filter((b) => b.k && !isPast(b) && b.st !== "cancelled");
  if (tracked.length === 0) return { list, changes: [] };

  const byToken = await fetchBookingStatuses(tracked.map((b) => b.k));
  // null — не дозвонились: ничего не меняем и ничего не досылаем.
  if (!byToken) return { list, changes: [] };

  const changes = [];
  const next = [];
  for (const b of list) {
    if (!tracked.includes(b)) {
      next.push(b);
      continue;
    }
    const row = byToken.get(b.k);

    if (!row) {
      if (b.sv === true) {
        // Строка была и пропала — мастер удалила её вместе с клиентом.
        const nb = { ...b, st: "cancelled" };
        changes.push(nb);
        next.push(nb);
      } else {
        // Судьба неизвестна — досылаем. Повтор безопасен: дубль
        // client_token сервер отвергнет, и submitBooking скажет true.
        const sv = await submitBooking(bookingRow(b));
        next.push(sv === b.sv ? b : { ...b, sv });
      }
      continue;
    }

    // Отменил сам клиент (с другого устройства) — у себя тоже убираем.
    if (row.status === "cancelled" && row.cancelledBy === "client") continue;

    let nb = b.sv === true ? b : { ...b, sv: true };
    if (row.status !== b.st) {
      nb = { ...nb, st: row.status };
      if (row.status === "ok" || row.status === "cancelled") changes.push(nb);
    }
    next.push(nb);
  }

  const changed = next.length !== list.length || next.some((b, i) => b !== list[i]);
  if (!changed) return { list, changes: [] };
  // saveBookings отдаёт то, что реально легло в хранилище (обрезанное
  // до лимита CloudStorage).
  return { list: await saveBookings(next), changes };
}

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** Текст тоста о решении мастера, или "" если сказать нечего. */
export function changesToast(changes) {
  if (changes.length === 0) return "";
  if (changes.length > 1) return "Статус ваших записей обновился — загляните в «Мои записи».";
  const [b] = changes;
  const when = `${lower(labelForKey(b.d))}, ${b.t}`;
  return b.st === "ok"
    ? `Запись подтверждена ✓ ${when}`
    : `Мастер отменила запись: ${when}`;
}
