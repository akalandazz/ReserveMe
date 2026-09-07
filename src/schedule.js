// Даты и свободные слоты. Чистые функции, без React и без Telegram.
//
// ⚠️ Здесь нигде не используется toISOString(): он переводит в UTC и
// в Тбилиси (UTC+4) превращает 8 сентября 01:00 в 7 сентября.
//
// Настройки приходят параметром, а не импортом: контент живёт в базе
// (src/content.js) и меняется во время работы приложения. Каждая
// функция обязана пережить settings == null — гейт загрузки в App.jsx
// может ещё не пропустить данные.

const pad = (n) => String(n).padStart(2, "0");

/** Date → "ГГГГ-ММ-ДД" в локальном времени. */
export function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "14:30" → 870 */
export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** 870 → "14:30" */
export function toHHMM(min) {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

// Конструктор Intl.DateTimeFormat дорогой — создаём форматтеры один раз
const fWeekdayShort = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });
const fWeekdayLong = new Intl.DateTimeFormat("ru-RU", { weekday: "long" });
const fDayMonth = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
});

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Ближайшие дни:
 * { key, dow, weekdayShort: "пн", dayMonth: "8 сентября",
 *   full: "Понедельник, 8 сентября", isToday, isTomorrow, isOpen }
 *
 * daysOff — массив ключей "ГГГГ-ММ-ДД" (отдельная таблица, меняется
 * независимо от остальных настроек).
 */
export function buildDays(settings, daysOff = []) {
  if (!settings) return [];
  const count = settings.bookingDaysAhead;
  const hours = settings.workingHours ?? {};

  const out = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const todayKey = dateKey(base);

  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i); // корректно перескакивает месяц и год
    const key = dateKey(d);
    const dow = d.getDay();
    out.push({
      key,
      dow,
      weekdayShort: fWeekdayShort.format(d),
      dayMonth: fDayMonth.format(d),
      full: `${cap(fWeekdayLong.format(d))}, ${fDayMonth.format(d)}`,
      isToday: key === todayKey,
      isTomorrow: i === 1,
      isOpen: Boolean(hours[dow]) && !daysOff.includes(key),
    });
  }
  return out;
}

/** "Сегодня, 8 сентября" / "Завтра, …" / "Понедельник, 8 сентября" */
export function dayLabel(day) {
  if (!day) return "";
  if (day.isToday) return `Сегодня, ${day.dayMonth}`;
  if (day.isTomorrow) return `Завтра, ${day.dayMonth}`;
  return day.full;
}

/** Найти день по ключу в уже построенном списке. */
export function findDay(days, key) {
  return days.find((d) => d.key === key) || null;
}

/**
 * Свободные слоты дня для услуги.
 * busy — [{ start, end }] в минутах от полуночи (свои же записи на эту дату).
 * Сетка идёт с шагом slotStepMinutes, но услуга должна успеть
 * закончиться до конца рабочего дня.
 */
export function buildSlots(day, service, busy = [], settings) {
  if (!settings || !day?.isOpen) return [];
  const hours = settings.workingHours?.[day.dow];
  if (!hours) return [];

  const step = settings.slotStepMinutes;
  const open = toMinutes(hours.from);
  const close = toMinutes(hours.to);
  const dur = service?.duration ?? step;

  let earliest = open;
  if (day.isToday) {
    const now = new Date();
    const soonest =
      now.getHours() * 60 + now.getMinutes() + settings.minLeadMinutes;
    earliest = Math.max(open, Math.ceil(soonest / step) * step);
  }

  const slots = [];
  for (let t = earliest; t + dur <= close; t += step) {
    const overlaps = busy.some((b) => t < b.end && t + dur > b.start);
    if (!overlaps) slots.push(toHHMM(t));
  }
  return slots;
}

/**
 * Занятые интервалы на дату из сохранённых записей.
 * Длительность берём из самой записи (b.m) — она денормализована
 * специально, чтобы правка услуги не переписывала историю.
 */
export function busyFor(bookings, key, settings) {
  const fallback = settings?.slotStepMinutes ?? 30;
  return bookings
    .filter((b) => b.d === key)
    .map((b) => ({
      start: toMinutes(b.t),
      end: toMinutes(b.t) + (b.m || fallback),
    }));
}

/** Запись уже в прошлом? */
export function isPast(b) {
  const [y, mo, d] = b.d.split("-").map(Number);
  const [h, mi] = b.t.split(":").map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime() < Date.now();
}

/** "8 сентября" для произвольного ключа "ГГГГ-ММ-ДД" (для прошедших записей). */
export function labelForKey(key) {
  const [y, mo, d] = key.split("-").map(Number);
  const date = new Date(y, mo - 1, d);
  return `${cap(fWeekdayLong.format(date))}, ${fDayMonth.format(date)}`;
}
