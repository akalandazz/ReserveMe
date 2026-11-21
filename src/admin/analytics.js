// Подписи вкладки «Аналитика» кабинета. Сами числа считает сервер —
// маршрут /api/analytics (supabase/functions/api/analytics.ts) модулем
// supabase/functions/_shared/analytics.js; кабинет получает их через
// fetchAnalytics (api.js) и только рисует. Здесь — то, что зависит от
// языка и часов устройства: период по умолчанию и подписи дат.
//
// Даты — по часам устройства, как и весь кабинет (dateKey, parseKey),
// никогда не через toISOString(). Период — { from, to }, ключи
// ГГГГ-ММ-ДД, оба дня включительно; null — без границы с этой стороны.

import { dateKey } from "../schedule.js";
import { parseKey } from "./calendar.js";

const firstOfMonth = (y, m) => dateKey(new Date(y, m, 1));
const lastOfMonth = (y, m) => dateKey(new Date(y, m + 1, 0));

/** Период по умолчанию и после «Сбросить»: этот календарный месяц, с 1-го по последний день. */
export function currentMonthRange(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  return { from: firstOfMonth(y, m), to: lastOfMonth(y, m) };
}

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

/** "2026-11" → подпись столбика «нояб». */
export function monthLabel(mk) {
  return fMonthShort.format(parseKey(`${mk}-01`)).replace(/\.$/, "");
}

/** "2026-11" → «Ноябрь 2026 г.» */
export function monthTitle(mk) {
  const s = fMonthLong.format(parseKey(`${mk}-01`));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** «+12% к прошлому периоду» / «−8% к прошлому периоду»; null — "". */
export function deltaLabel(delta) {
  if (delta == null) return "";
  return `${delta >= 0 ? "+" : "−"}${Math.abs(delta)}% к прошлому периоду`;
}
