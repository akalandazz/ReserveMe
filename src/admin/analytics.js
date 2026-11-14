// Чистые производные для вкладки «Аналитика» кабинета. Без React, без
// Supabase — считается из записей, которые store.js уже загрузил целиком
// (selectAll), так что отдельного запроса к серверу нет.
//
// Визит — подтверждённая запись (status "ok"), которая уже началась.
// Заявки, отменённые (store.js их и так отсекает) и будущие записи —
// не визиты и денег не приносят. Деньги — цена, сохранённая на самой
// записи (bookings.price), а не нынешняя цена услуги.
//
// Даты — по часам устройства, как и весь кабинет (dateKey, parseKey),
// никогда не через toISOString().

import { dateKey } from "../schedule.js";
import { parseKey } from "./calendar.js";

export const PERIODS = [
  { id: "m", tab: "Месяц", label: "за 30 дней", days: 30 },
  { id: "q", tab: "3 мес.", label: "за 90 дней", days: 90 },
  { id: "y", tab: "Год", label: "за год", days: 365 },
  { id: "all", tab: "Всё", label: "за всё время", days: null },
];

export const TOP_CLIENTS = 5;
export const RARE_CLIENTS = 4;
export const CHART_MONTHS = 6;

const pad = (n) => String(n).padStart(2, "0");

function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/** Начало записи, мс по часам устройства. */
export function bookingStart(b) {
  return parseKey(b.day).getTime() + b.start_min * 60000;
}

/** Визит: подтверждена и уже началась. */
export function isVisit(b, now = new Date()) {
  return b.status === "ok" && bookingStart(b) < now.getTime();
}

/**
 * Период целыми днями назад от сегодня, включая сегодня: { from, to } —
 * ключи ГГГГ-ММ-ДД, from === null — «всё время». prev — такой же отрезок
 * прямо перед ним (для «Всё» — null).
 */
export function periodRange(periodId, now = new Date()) {
  const p = PERIODS.find((x) => x.id === periodId) ?? PERIODS[0];
  const today = dateKey(now);
  if (!p.days) return { from: null, to: today, prev: null };
  return {
    from: addDays(today, -(p.days - 1)),
    to: today,
    prev: { from: addDays(today, -(2 * p.days - 1)), to: addDays(today, -p.days) },
  };
}

const inRange = (b, r) => (r.from == null || b.day >= r.from) && b.day <= r.to;

export const sumPrice = (list) => list.reduce((s, b) => s + (Number(b.price) || 0), 0);

const byNewest = (a, b) => b.day.localeCompare(a.day) || b.start_min - a.start_min;

const fMonthShort = new Intl.DateTimeFormat("ru-RU", { month: "short" });
const fMonthLong = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });

/** Ключ месяца "ГГГГ-ММ" и подпись столбика «нояб» для месяца back назад. */
function monthAt(now, back) {
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  return {
    mk: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    label: fMonthShort.format(d).replace(/\.$/, ""),
  };
}

/** Шесть столбиков: текущий месяц и пять до него, старые слева. Период на них не влияет. */
export function monthTotals(visits, now = new Date()) {
  const months = [];
  for (let back = CHART_MONTHS - 1; back >= 0; back--) {
    const { mk, label } = monthAt(now, back);
    const total = sumPrice(visits.filter((b) => b.day.startsWith(`${mk}-`)));
    months.push({ mk, label, total, current: back === 0 });
  }
  return months;
}

/** Визиты месяца "ГГГГ-ММ", новые сверху. */
export function monthVisits(visits, mk) {
  return visits.filter((b) => b.day.startsWith(`${mk}-`)).sort(byNewest);
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
 * Всё, что показывает вкладка, кроме графика по месяцам:
 *  visits (все визиты — для графика), revenue, delta (процент к прошлому
 *  периоду или null — скрыть), visitCount, avg (null, если визитов нет),
 *  clientCount, services, top, rare.
 *
 * top — до 5 клиентов с наибольшим числом визитов за период (при
 * равенстве — по деньгам). rare — до 4 остальных клиентов базы: сначала те,
 * кто ни разу не был, затем по числу визитов за период (меньше — выше),
 * затем по давности последнего визита (дольше — выше). У каждого — next,
 * ближайшая будущая запись или заявка (или null).
 */
export function analyticsFor({ bookings, clients, period, now = new Date() }) {
  const visits = bookings.filter((b) => isVisit(b, now));
  const range = periodRange(period, now);
  const inPeriod = visits.filter((b) => inRange(b, range));

  const revenue = sumPrice(inPeriod);
  const prevRevenue = range.prev ? sumPrice(visits.filter((b) => inRange(b, range.prev))) : 0;
  const delta =
    range.prev && prevRevenue > 0 ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100) : null;

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
    visits,
    revenue,
    delta,
    visitCount: inPeriod.length,
    avg: inPeriod.length ? revenue / inPeriod.length : null,
    clientCount: new Set(inPeriod.map((b) => b.client_id).filter((id) => id != null)).size,
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
