// Расчёт вкладки «Аналитика» кабинета — на сервере (Edge Function api,
// маршрут /api/analytics, см. api/analytics.ts). Чистый JS без Deno и без
// Intl-подписей: его же исполняют e2e/unit (Node) и подделка Supabase в
// UI-тестах. Подписи («1 – 30 нояб.», «Ноябрь 2026 г.») — в кабинете,
// src/admin/analytics.js.
//
// Считаются только подтверждённые записи (status "ok"):
//  - визит — уже началась: «Заработано»;
//  - впереди — ещё не началась: «Ожидается».
// Заявки и отменённые не считаются нигде. Деньги — цена, сохранённая на
// самой записи (bookings.price), а не нынешняя цена услуги.
//
// «Сейчас» — настенное время салона { day: "ГГГГ-ММ-ДД", min }: записи
// хранят день и минуту начала по местным часам, а сервер живёт в UTC.
// wallClock(date, timeZone) переводит момент в такое время. Дни считаем
// через Date.UTC — от часового пояса процесса ничего не зависит.
// Период — { from, to }, ключи ГГГГ-ММ-ДД, оба дня включительно; null —
// без границы с этой стороны.

export const TOP_CLIENTS = 5;
export const RARE_CLIENTS = 4;
export const CHART_MONTHS = 6;

const pad = (n) => String(n).padStart(2, "0");
const DAY_MS = 86400000;
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "ГГГГ-ММ-ДД" — настоящая дата? */
export function isDayKey(key) {
  if (typeof key !== "string" || !KEY_RE.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const utcKey = (t) => `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
const keyUtc = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
/** Ключ дня y/m (месяц с 0, может выходить за 0..11) и d. */
const keyOf = (y, m, d) => utcKey(new Date(Date.UTC(y, m, d)));

function addDays(key, n) {
  return utcKey(new Date(keyUtc(key) + n * DAY_MS));
}

/**
 * Настенное время { day, min }: в часовом поясе timeZone ("Asia/Tbilisi")
 * или, без него, по местным часам процесса.
 */
export function wallClock(date = new Date(), timeZone) {
  if (!timeZone) {
    return {
      day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      min: date.getHours() * 60 + date.getMinutes(),
    };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    min: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** now — Date (местные часы) или уже { day, min }. */
const toWall = (now) => (now instanceof Date ? wallClock(now) : now);

/** Запись началась к моменту now ({ day, min })? */
function started(b, now) {
  return b.day < now.day || (b.day === now.day && b.start_min < now.min);
}

/** Визит: подтверждена и уже началась. */
export function isVisit(b, now = new Date()) {
  return b.status === "ok" && started(b, toWall(now));
}

/** Впереди: подтверждена и ещё не началась. */
export function isUpcoming(b, now = new Date()) {
  return b.status === "ok" && !started(b, toWall(now));
}

/** Период — целые календарные месяцы (с 1-го по последний день)? Тогда сколько. */
function wholeMonths(from, to) {
  if (from.slice(8) !== "01" || addDays(to, 1).slice(8) !== "01") return 0;
  const [ay, am] = from.split("-").map(Number);
  const [by, bm] = to.split("-").map(Number);
  return (by - ay) * 12 + bm - am + 1;
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
    const [y, m] = from.split("-").map(Number);
    return { from: keyOf(y, m - 1 - months, 1), to: addDays(from, -1) };
  }
  const days = Math.round((keyUtc(to) - keyUtc(from)) / DAY_MS) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

const inRange = (b, r) => (r.from == null || b.day >= r.from) && (r.to == null || b.day <= r.to);

export const sumPrice = (list) => list.reduce((s, b) => s + (Number(b.price) || 0), 0);

const inMonth = (mk) => (b) => b.day.startsWith(`${mk}-`);

/**
 * Шесть столбиков: текущий месяц и пять до него, старые слева. Период на
 * них не влияет. earned — визиты месяца, expected — его подтверждённые
 * записи, которые ещё впереди. Подписи месяцев — в кабинете, по mk.
 */
export function monthTotals(bookings, now = new Date()) {
  const wall = toWall(now);
  const visits = bookings.filter((b) => isVisit(b, wall));
  const upcoming = bookings.filter((b) => isUpcoming(b, wall));
  const [y, m] = wall.day.split("-").map(Number);
  const months = [];
  for (let back = CHART_MONTHS - 1; back >= 0; back--) {
    const mk = keyOf(y, m - 1 - back, 1).slice(0, 7);
    months.push({
      mk,
      earned: sumPrice(visits.filter(inMonth(mk))),
      expected: sumPrice(upcoming.filter(inMonth(mk))),
      current: back === 0,
    });
  }
  return months;
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

/** Сравнение начала двух записей (day, start_min). */
const byStart = (a, b) => a.day.localeCompare(b.day) || a.start_min - b.start_min;

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
  const wall = toWall(now);
  const range = { from, to };
  const visits = bookings.filter((b) => isVisit(b, wall));
  const inPeriod = visits.filter((b) => inRange(b, range));
  const ahead = bookings.filter((b) => isUpcoming(b, wall) && inRange(b, range));

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

  const nextFor = new Map();
  for (const b of bookings) {
    if (b.client_id == null || b.status === "cancelled" || started(b, wall)) continue;
    const cur = nextFor.get(b.client_id);
    if (!cur || byStart(b, cur) < 0) nextFor.set(b.client_id, b);
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

/**
 * Проверка тела запроса { from, to }: ключи ГГГГ-ММ-ДД или null, from ≤ to.
 * → { from, to } или null — неверно.
 */
export function parseRange(body) {
  const from = body?.from ?? null;
  const to = body?.to ?? null;
  if (from !== null && !isDayKey(from)) return null;
  if (to !== null && !isDayKey(to)) return null;
  if (from && to && from > to) return null;
  return { from, to };
}

// Наружу из карточки клиента — только то, что рисует вкладка (имя,
// кружок, contactLink): без комментариев, счётчиков и статусов приглашения.
const publicClient = (c) => ({
  id: c.id,
  name: c.name ?? "",
  telegram_username: c.telegram_username ?? "",
  phone: c.phone ?? "",
  channel: c.channel ?? "",
});

/**
 * Ответ маршрута /api/analytics: сводка за период и шесть месяцев.
 * bookings — записи салона (отменённые отбрасываются здесь), clients — его
 * карточки (client_stats). Имя на записи — от клиента по client_id, как
 * withClientNames в store.js кабинета.
 */
export function analyticsReport({ bookings, clients, from = null, to = null, now }) {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const named = bookings
    .filter((b) => b.status !== "cancelled")
    .map((b) => {
      const c = b.client_id != null ? byId.get(b.client_id) : null;
      return c ? { ...b, client_name: c.name || b.client_name } : b;
    });
  const wall = toWall(now);
  const a = analyticsFor({ bookings: named, clients, from, to, now: wall });
  return {
    now: wall,
    summary: {
      ...a,
      top: a.top.map((t) => ({ ...t, client: publicClient(t.client) })),
      rare: a.rare.map((r) => ({
        ...r,
        client: publicClient(r.client),
        next: r.next ? { day: r.next.day, start_min: r.next.start_min } : null,
      })),
    },
    months: monthTotals(named, wall),
  };
}
