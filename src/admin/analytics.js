// Чистые производные для вкладки «Аналитика» кабинета. Без React, без
// Supabase — считается из записей, которые store.js уже загрузил целиком
// (selectAll), так что отдельного запроса к серверу нет.
//
// Считаются только подтверждённые записи (status "ok"):
//  - визит — уже началась: «Заработано»;
//  - впереди — ещё не началась: «Ожидается».
// Заявки и отменённые (store.js их и так отсекает) не считаются нигде.
// Деньги — цена, сохранённая на самой записи (bookings.price), а не
// нынешняя цена услуги.
//
// Даты — по часам устройства, как и весь кабинет (dateKey, parseKey),
// никогда не через toISOString(). Период — { from, to }, ключи
// ГГГГ-ММ-ДД, оба дня включительно; null — без границы с этой стороны.

import { dateKey } from "../schedule.js";
import { parseKey } from "./calendar.js";

export const TOP_CLIENTS = 5;
export const RARE_CLIENTS = 4;
export const CHART_MONTHS = 6;

const pad = (n) => String(n).padStart(2, "0");
const DAY_MS = 86400000;

function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

const firstOfMonth = (y, m) => dateKey(new Date(y, m, 1));
const lastOfMonth = (y, m) => dateKey(new Date(y, m + 1, 0));

/** Начало записи, мс по часам устройства. */
export function bookingStart(b) {
  return parseKey(b.day).getTime() + b.start_min * 60000;
}

/** Визит: подтверждена и уже началась. */
export function isVisit(b, now = new Date()) {
  return b.status === "ok" && bookingStart(b) < now.getTime();
}

/** Впереди: подтверждена и ещё не началась. */
export function isUpcoming(b, now = new Date()) {
  return b.status === "ok" && bookingStart(b) >= now.getTime();
}

/** Период по умолчанию и после «Сбросить»: этот календарный месяц, с 1-го по последний день. */
export function currentMonthRange(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  return { from: firstOfMonth(y, m), to: lastOfMonth(y, m) };
}

/** Период — целые календарные месяцы (с 1-го по последний день)? Тогда сколько. */
function wholeMonths(from, to) {
  const a = parseKey(from);
  const b = parseKey(to);
  if (a.getDate() !== 1 || addDays(to, 1).slice(8) !== "01") return 0;
  return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() + 1;
}

/**
 * Такой же отрезок прямо перед периодом: для целых месяцев — столько же
 * месяцев до него (ноябрь → октябрь, а не «30 дней до 1 ноября»), иначе —
 * столько же дней. Без одной из границ — null.
 */
export function previousRange({ from, to }) {
  if (!from || !to) return null;
  const months = wholeMonths(from, to);
  if (months) {
    const a = parseKey(from);
    return {
      from: firstOfMonth(a.getFullYear(), a.getMonth() - months),
      to: addDays(from, -1),
    };
  }
  const days = Math.round((parseKey(to) - parseKey(from)) / DAY_MS) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

const inRange = (b, r) => (r.from == null || b.day >= r.from) && (r.to == null || b.day <= r.to);

export const sumPrice = (list) => list.reduce((s, b) => s + (Number(b.price) || 0), 0);

const byNewest = (a, b) => b.day.localeCompare(a.day) || b.start_min - a.start_min;

const fMonthShort = new Intl.DateTimeFormat("ru-RU", { month: "short" });
const fMonthLong = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });
const fDayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const fDayMonthYear = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * Подпись периода: «1 – 30 нояб.», «5 окт. – 12 нояб.»,
 * «5 окт. 2025 г. – 12 янв. 2026 г.», «14 нояб.»; без границ — «всё время».
 */
export function rangeLabel({ from, to }) {
  if (!from && !to) return "всё время";
  if (!from) return `по ${fDayMonth.format(parseKey(to))}`;
  if (!to) return `с ${fDayMonth.format(parseKey(from))}`;
  const a = parseKey(from);
  const b = parseKey(to);
  if (from === to) return fDayMonth.format(a);
  if (a.getFullYear() !== b.getFullYear()) {
    return `${fDayMonthYear.format(a)} – ${fDayMonthYear.format(b)}`;
  }
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} – ${fDayMonth.format(b)}`;
  return `${fDayMonth.format(a)} – ${fDayMonth.format(b)}`;
}

/** Ключ месяца "ГГГГ-ММ" и подпись столбика «нояб» для месяца back назад. */
function monthAt(now, back) {
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  return {
    mk: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    label: fMonthShort.format(d).replace(/\.$/, ""),
  };
}

const inMonth = (mk) => (b) => b.day.startsWith(`${mk}-`);

/**
 * Шесть столбиков: текущий месяц и пять до него, старые слева. Период на
 * них не влияет. earned — визиты месяца, expected — его подтверждённые
 * записи, которые ещё впереди.
 */
export function monthTotals(bookings, now = new Date()) {
  const visits = bookings.filter((b) => isVisit(b, now));
  const upcoming = bookings.filter((b) => isUpcoming(b, now));
  const months = [];
  for (let back = CHART_MONTHS - 1; back >= 0; back--) {
    const { mk, label } = monthAt(now, back);
    months.push({
      mk,
      label,
      earned: sumPrice(visits.filter(inMonth(mk))),
      expected: sumPrice(upcoming.filter(inMonth(mk))),
      current: back === 0,
    });
  }
  return months;
}

/**
 * Записи месяца "ГГГГ-ММ" для истории под графиком: визиты и
 * подтверждённые будущие (upcoming: true), поздние сверху.
 */
export function monthEntries(bookings, mk, now = new Date()) {
  return bookings
    .filter((b) => inMonth(mk)(b) && b.status === "ok")
    .map((b) => ({ ...b, upcoming: isUpcoming(b, now) }))
    .sort(byNewest);
}

/** "2026-11" → «Ноябрь 2026 г.» */
export function monthTitle(mk) {
  const s = fMonthLong.format(parseKey(`${mk}-01`));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Услуги записи для «Популярных услуг». Запись из нескольких услуг —
 * визит каждой из них по цене её снимка (bookings.services); у записи из
 * одной услуги — её собственная цена. Старые строки без снимка — по
 * service_id/service_name.
 */
function servicesOf(b) {
  const snap = Array.isArray(b.services) && b.services.length ? b.services : null;
  if (!snap || snap.length === 1) {
    const s = snap?.[0];
    return [
      {
        id: s?.id ?? b.service_id,
        name: s?.name || b.service_name || "Услуга",
        price: Number(b.price) || 0,
      },
    ];
  }
  return snap.map((s) => ({ id: s.id, name: s.name || "Услуга", price: Number(s.price) || 0 }));
}

/** Услуги с визитами, по числу визитов, при равенстве — по деньгам. */
export function popularServices(list) {
  const map = new Map();
  for (const b of list) {
    for (const s of servicesOf(b)) {
      const key = s.id ?? `name:${s.name}`;
      const cur = map.get(key) ?? { id: key, name: s.name, visits: 0, sum: 0 };
      cur.visits += 1;
      cur.sum += s.price;
      map.set(key, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.visits - a.visits || b.sum - a.sum);
}

/**
 * Всё, что показывает вкладка за период { from, to }, кроме графика:
 *  earned (визиты), expected (подтверждённые впереди), total, delta
 *  (процент total к такому же отрезку перед периодом или null — скрыть),
 *  visitCount, upcomingCount, avg (средний чек визитов или null),
 *  clientCount, services, top, rare.
 *
 * Услуги и клиенты — только по визитам: ещё не случившаяся запись — не
 * визит. top — до 5 клиентов с наибольшим числом визитов (при равенстве —
 * по деньгам). rare — до 4 остальных клиентов базы: сначала те, кто ни
 * разу не был, затем по числу визитов за период (меньше — выше), затем по
 * давности последнего визита (дольше — выше). У каждого — next, ближайшая
 * будущая запись или заявка (или null).
 */
export function analyticsFor({ bookings, clients, from = null, to = null, now = new Date() }) {
  const range = { from, to };
  const visits = bookings.filter((b) => isVisit(b, now));
  const inPeriod = visits.filter((b) => inRange(b, range));
  const ahead = bookings.filter((b) => isUpcoming(b, now) && inRange(b, range));

  const earned = sumPrice(inPeriod);
  const expected = sumPrice(ahead);
  const total = earned + expected;

  const prev = previousRange(range);
  const prevTotal = prev
    ? sumPrice(bookings.filter((b) => b.status === "ok" && inRange(b, prev)))
    : 0;
  const delta = prev && prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;

  // Последний визит клиента — за всё время, не только за период.
  const lastVisit = new Map();
  for (const b of visits) {
    if (b.client_id == null) continue;
    const cur = lastVisit.get(b.client_id);
    if (!cur || b.day > cur) lastVisit.set(b.client_id, b.day);
  }

  const perClient = new Map();
  for (const b of inPeriod) {
    if (b.client_id == null) continue;
    const cur = perClient.get(b.client_id) ?? { visits: 0, sum: 0, name: b.client_name };
    cur.visits += 1;
    cur.sum += Number(b.price) || 0;
    perClient.set(b.client_id, cur);
  }

  const clientById = new Map(clients.map((c) => [c.id, c]));
  const top = [...perClient.entries()]
    .map(([id, s]) => ({
      client: clientById.get(id) ?? { id, name: s.name },
      visits: s.visits,
      sum: s.sum,
      lastVisit: lastVisit.get(id) ?? null,
    }))
    .sort((a, b) => b.visits - a.visits || b.sum - a.sum)
    .slice(0, TOP_CLIENTS);
  const topIds = new Set(top.map((t) => t.client.id));

  const nowMs = now.getTime();
  const nextFor = new Map();
  for (const b of bookings) {
    if (b.client_id == null || b.status === "cancelled" || bookingStart(b) < nowMs) continue;
    const cur = nextFor.get(b.client_id);
    if (!cur || bookingStart(b) < bookingStart(cur)) nextFor.set(b.client_id, b);
  }

  const rare = clients
    .filter((c) => !topIds.has(c.id))
    .map((c) => ({
      client: c,
      visits: perClient.get(c.id)?.visits ?? 0,
      lastVisit: lastVisit.get(c.id) ?? null,
      next: nextFor.get(c.id) ?? null,
    }))
    .sort(
      (a, b) =>
        (a.lastVisit == null ? 0 : 1) - (b.lastVisit == null ? 0 : 1) ||
        a.visits - b.visits ||
        (a.lastVisit ?? "").localeCompare(b.lastVisit ?? "")
    )
    .slice(0, RARE_CLIENTS);

  return {
    earned,
    expected,
    total,
    delta,
    visitCount: inPeriod.length,
    upcomingCount: ahead.length,
    avg: inPeriod.length ? earned / inPeriod.length : null,
    clientCount: perClient.size,
    services: popularServices(inPeriod),
    top,
    rare,
  };
}

/** «+12% к прошлому периоду» / «−8% к прошлому периоду»; null — "". */
export function deltaLabel(delta) {
  if (delta == null) return "";
  return `${delta >= 0 ? "+" : "−"}${Math.abs(delta)}% к прошлому периоду`;
}
