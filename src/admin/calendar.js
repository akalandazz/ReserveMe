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

export const PX_H = 40; // высота часа на временной шкале, px

const FALLBACK_FROM = 9 * 60;
const FALLBACK_TO = 20 * 60;
const MIN_HOURS = 4; // не схлопывать шкалу в полоску на пустой неделе

/** Понедельник недели, содержащей key. */
export function weekStart(key) {
  const d = parseKey(key);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/**
 * Диапазон шкалы недели: рабочие часы показанных дней плюс всё, что в
 * них не попало. Фиксированной сетки «с 8 до 21» нет намеренно — при
 * графике 10:00–19:00 треть колонки уходила в пустоту, а запись,
 * перенесённая мастером за пределы графика, из сетки просто выпадала.
 */
export function weekRange(settings, keys, bookings, blockedSlots, step = 30) {
  const days = new Set(keys);
  let from = Infinity;
  let to = -Infinity;

  for (const key of keys) {
    const h = hoursFor(settings, parseKey(key).getDay());
    if (!h) continue;
    from = Math.min(from, toMinutes(h.from));
    to = Math.max(to, toMinutes(h.to));
  }
  for (const b of bookings) {
    if (!days.has(b.day)) continue;
    from = Math.min(from, b.start_min);
    to = Math.max(to, b.start_min + (b.duration || step));
  }
  for (const b of blockedSlots) {
    if (!days.has(b.day)) continue;
    from = Math.min(from, b.start_min);
    to = Math.max(to, b.start_min + step);
  }
  if (!Number.isFinite(from)) {
    from = FALLBACK_FROM;
    to = FALLBACK_TO;
  }

  from = Math.max(0, Math.floor(from / 60) * 60);
  to = Math.min(24 * 60, Math.ceil(to / 60) * 60);
  if (to - from < MIN_HOURS * 60) to = Math.min(24 * 60, from + MIN_HOURS * 60);
  return { from, to, hours: (to - from) / 60 };
}

/** Подписи часов — по одной на каждую линию сетки, включая нижнюю. */
export function hourLabels(range) {
  const out = [];
  for (let m = range.from; m <= range.to; m += 60) out.push(toHHMM(m));
  return out;
}

/** Позиция и высота отрезка [startMin, +duration) на шкале недели, в px. */
export function eventGeometry(range, startMin, duration) {
  const top = ((startMin - range.from) * PX_H) / 60;
  const h = (duration * PX_H) / 60;
  const clipped = Math.max(0, top);
  return {
    top: clipped,
    h: Math.max(14, top + h - clipped),
  };
}

/**
 * Раскладка пересекающихся событий по дорожкам внутри колонки дня.
 * Две заявки на одно время — штатная ситуация (клиент не видит чужих
 * записей и может попросить занятый слот), и в сетке они должны быть
 * видны обе, а не одна поверх другой.
 */
export function layoutEvents(events) {
  const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const lanes = cluster.reduce((n, e) => Math.max(n, e.lane + 1), 0);
    for (const e of cluster) out.push({ ...e, lanes });
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const e of sorted) {
    if (e.start >= clusterEnd) flush();
    const taken = new Set(cluster.filter((x) => x.end > e.start).map((x) => x.lane));
    let lane = 0;
    while (taken.has(lane)) lane++;
    cluster.push({ ...e, lane });
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  flush();
  return out;
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
