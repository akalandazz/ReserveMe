// Чистые производные для календаря кабинета мастера: месяц/неделя/день.
// Без React, без Telegram — та же дисциплина, что у src/schedule.js.
//
// Общие даты (dateKey/toMinutes/toHHMM/labelForKey) переиспользуются из
// src/schedule.js: это те же самые "ГГГГ-ММ-ДД" и минуты от полуночи,
// что и в bookings/settings.working_hours. Здесь — только то, что
// специфично для страницы мастера: разбор произвольного ключа обратно
// в Date, сетка недели и сплошная (не завязанная на услугу) сетка дня.

import { toHHMM, toMinutes } from "../schedule.js";

/** "ГГГГ-ММ-ДД" -> Date в локальном времени. Обратное к dateKey(). */
export function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Рабочие часы дня недели по графику ({from,to} | null — выходной). */
export function hoursFor(settings, dow) {
  return settings?.workingHours?.[dow] ?? null;
}

/** День закрыт целиком: либо нерабочий по графику, либо в days_off. */
export function isDayClosed(settings, daysOff, key) {
  const dow = parseKey(key).getDay();
  return !hoursFor(settings, dow) || daysOff.includes(key);
}

export function bookingsForDay(bookings, key) {
  return bookings
    .filter((b) => b.day === key)
    .sort((a, b) => a.start_min - b.start_min);
}

export function blockedMinutesForDay(blockedSlots, key) {
  return blockedSlots.filter((b) => b.day === key).map((b) => b.start_min);
}

/** Запись уже в прошлом? */
export function isBookingPast(b) {
  return parseKey(b.day).getTime() + b.start_min * 60000 < Date.now();
}

/** Сколько записей на каждый день — для точек в месячной сетке. */
export function bookingCountsByDay(bookings) {
  const map = new Map();
  for (const b of bookings) map.set(b.day, (map.get(b.day) || 0) + 1);
  return map;
}

/* ─── Неделя ────────────────────────────────────────────────────── */

export const GRID_FROM = 8 * 60; // 08:00 — с запасом раньше самого раннего графика
export const GRID_HOURS = 13; // до 21:00
export const PX_H = 34; // высота часа на временной шкале, px

/** Понедельник недели, содержащей key. */
export function weekStart(key) {
  const d = parseKey(key);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export function hourLabels() {
  const out = [];
  for (let m = GRID_FROM; m < GRID_FROM + GRID_HOURS * 60; m += 60) {
    out.push(toHHMM(m));
  }
  return out;
}

/** Позиция и высота события на временной шкале недели, в px. */
export function eventGeometry(startMin, duration) {
  return {
    top: Math.max(0, ((startMin - GRID_FROM) * PX_H) / 60),
    h: Math.max(18, (duration * PX_H) / 60 - 2),
  };
}

/* ─── День ──────────────────────────────────────────────────────── */

/**
 * Слоты дня для панели «День»: карточка записи либо Свободно/Закрыто,
 * шагом settings.slotStepMinutes. Не переиспользует buildSlots() из
 * src/schedule.js — та считает окна под конкретную услугу клиента,
 * а здесь нужна сплошная сетка независимо от услуги.
 */
export function buildDayRows(settings, daysOff, bookings, blockedSlots, key) {
  const dow = parseKey(key).getDay();
  const hours = hoursFor(settings, dow);
  const closedByOff = daysOff.includes(key);
  if (!hours || closedByOff) {
    return { closed: true, closedByOff, rows: [], freeCount: 0 };
  }

  const step = settings.slotStepMinutes || 30;
  const open = toMinutes(hours.from);
  const close = toMinutes(hours.to);
  const list = bookingsForDay(bookings, key);
  const blocked = blockedMinutesForDay(blockedSlots, key);

  const rows = [];
  let freeCount = 0;
  let t = open;
  while (t < close) {
    const b = list.find(
      (x) => x.start_min <= t && t < x.start_min + (x.duration || step)
    );
    if (b && b.start_min === t) {
      rows.push({ type: "booking", time: toHHMM(b.start_min), booking: b });
      t = b.start_min + (b.duration || step);
      continue;
    }
    if (b) {
      // середина уже показанной записи — пропускаем до следующего шага
      t += step;
      continue;
    }
    const isBlocked = blocked.includes(t);
    if (!isBlocked) freeCount++;
    rows.push({ type: "free", time: toHHMM(t), blocked: isBlocked, minute: t });
    t += step;
  }
  return { closed: false, closedByOff: false, rows, freeCount };
}
