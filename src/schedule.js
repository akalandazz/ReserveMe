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
 * Часы конкретной даты ({ from, to } | null): дата в daysOff — закрыта;
 * есть в daysOpen (разово открытый выходной) — её часы; иначе — график
 * дня недели. То же правило, что hours_for_day() в schema.sql: сервер
 * по нему принимает заявку, поэтому меняются вместе.
 *
 * daysOff — массив ключей "ГГГГ-ММ-ДД", daysOpen — { "ГГГГ-ММ-ДД": { from, to } }
 * (отдельные таблицы, меняются независимо от остальных настроек).
 */
export function hoursForDay(settings, daysOff = [], daysOpen = {}, key) {
  if (!settings || daysOff.includes(key)) return null;
  if (daysOpen[key]) return daysOpen[key];
  const [y, mo, d] = key.split("-").map(Number);
  return settings.workingHours?.[new Date(y, mo - 1, d).getDay()] ?? null;
}

/** Строки days_open → { "ГГГГ-ММ-ДД": { from, to } } — форма для hoursForDay(). */
export function toDaysOpen(rows) {
  const out = {};
  for (const r of rows ?? []) {
    if (r?.day && r.hours?.from && r.hours?.to) out[r.day] = { from: r.hours.from, to: r.hours.to };
  }
  return out;
}

/**
 * Ближайшие дни:
 * { key, dow, weekdayShort: "пн", dayMonth: "8 сентября",
 *   full: "Понедельник, 8 сентября", isToday, isTomorrow, isOpen,
 *   hours: { from, to } | null }
 */
export function buildDays(settings, daysOff = [], daysOpen = {}) {
  if (!settings) return [];
  const count = settings.bookingDaysAhead;

  const out = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const todayKey = dateKey(base);

  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i); // корректно перескакивает месяц и год
    const key = dateKey(d);
    const dow = d.getDay();
    const hours = hoursForDay(settings, daysOff, daysOpen, key);
    out.push({
      key,
      dow,
      weekdayShort: fWeekdayShort.format(d),
      dayMonth: fDayMonth.format(d),
      full: `${cap(fWeekdayLong.format(d))}, ${fDayMonth.format(d)}`,
      isToday: key === todayKey,
      isTomorrow: i === 1,
      isOpen: Boolean(hours),
      hours,
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

/** Сколько услуг можно взять в одну запись — max_services в services_total() (schema.sql). */
export const MAX_SERVICES = 4;

/**
 * Выбранные услуги в порядке прайса (services уже отсортирован по sort, id),
 * а не в порядке, в котором их отметили, — так же их складывает сервер.
 */
export function pickServices(services = [], ids = []) {
  return services.filter((s) => ids.includes(s.id));
}

/**
 * Несколько услуг — одна запись подряд: { ids, name, duration, price }.
 * Подпись — та же, что services_total() в schema.sql («Маникюр + Педикюр»):
 * её сервер пишет в bookings.service_name. Пустой список — null.
 */
export function combineServices(list = []) {
  if (list.length === 0) return null;
  return {
    ids: list.map((s) => s.id),
    name: list.map((s) => s.name).join(" + "),
    duration: list.reduce((sum, s) => sum + (Number(s.duration) || 0), 0),
    price: list.reduce((sum, s) => sum + (Number(s.price) || 0), 0),
  };
}

/**
 * Свободные слоты дня для услуги (или combineServices() нескольких).
 * busy — [{ start, end }] в минутах от полуночи (свои же записи на эту дату).
 * Сетка идёт с шагом slotStepMinutes, но услуга должна успеть
 * закончиться до конца рабочего дня.
 */
export function buildSlots(day, service, busy = [], settings) {
  if (!settings || !day?.isOpen) return [];
  const hours = day.hours;
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
 * Занятость с сервера (вьюха busy_slots) на дату.
 * Это то, что мастер видит и настраивает в кабинете: чужие заявки,
 * записи, заведённые ею вручную, и закрытые вручную окошки.
 *
 * duration = 0 — закрытое окошко (blocked_slots): длиной ровно
 * в шаг сетки, иначе интервал нулевой длины ничего бы не перекрыл
 * и слот на это же время остался бы кликабельным.
 */
export function serverBusyFor(busy = [], key, settings) {
  const step = settings?.slotStepMinutes ?? 30;
  return busy
    .filter((b) => b.day === key)
    .map((b) => ({ start: b.start, end: b.start + (b.duration || step) }));
}

/** Запись ({ day: "ГГГГ-ММ-ДД", time: "ЧЧ:ММ" }) уже в прошлом? */
export function isPast(b) {
  const [y, mo, d] = b.day.split("-").map(Number);
  const [h, mi] = b.time.split(":").map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime() < Date.now();
}

/** "8 сентября" для произвольного ключа "ГГГГ-ММ-ДД" (для прошедших записей). */
export function labelForKey(key) {
  const [y, mo, d] = key.split("-").map(Number);
  const date = new Date(y, mo - 1, d);
  return `${cap(fWeekdayLong.format(date))}, ${fDayMonth.format(date)}`;
}
