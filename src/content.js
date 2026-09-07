// Весь контент салона: услуги, график, адрес, тексты.
//
// Это рантайм-замена прежнего src/data.js. Раньше контент был набором
// констант, которые Vite инлайнил при сборке; теперь он лежит в Supabase
// и правится из админки внутри приложения.
//
// Один стор на четыре таблицы: строк там пара десятков, и разносить их
// по отдельным сторам с отдельными состояниями загрузки нечего.
//
// Форма модуля — с src/storage.js (константы наверху, try/catch вокруг
// каждого обращения к localStorage, повреждённые данные не роняют экран,
// функции резолвятся вместо throw). Идиома подписки — с src/theme.js.

import { useSyncExternalStore } from "react";
import { NOT_CONFIGURED, supabase } from "./supabase.js";

/** Ключ кэша. Менять при смене формы хранимого объекта. */
const CACHE_KEY = "vs_content_v1";

const EMPTY = {
  status: "loading",
  error: null,
  stale: false,
  settings: null,
  services: [],
  activeServices: [],
  daysOff: [],
  infoBlocks: [],
};

/* ─── Нормализация ──────────────────────────────────────────────
   snake_case из PostgREST дальше границы стора не уходит: экраны
   видят только camelCase, а location собран обратно в объект —
   так LocationScreen меняется в одну строку.                     */

function toSettings(row) {
  if (!row) return null;
  return {
    masterName: row.master_name ?? "",
    masterUsername: row.master_username ?? "",
    masterPhone: row.master_phone ?? "",
    slotStepMinutes: Number(row.slot_step_minutes) || 30,
    bookingDaysAhead: Number(row.booking_days_ahead) || 14,
    minLeadMinutes: Number(row.min_lead_minutes) || 0,
    workingHoursText: row.working_hours_text ?? "",
    workingHours: row.working_hours ?? {},
    timeOfDay: Array.isArray(row.time_of_day) ? row.time_of_day : [],
    location: {
      address: row.address ?? "",
      landmark: row.landmark ?? "",
      transport: row.transport ?? "",
      mapUrl: row.map_url ?? "",
    },
  };
}

/** Обратно в колонки таблицы. updated_at не отправляем — им владеет триггер. */
function settingsToRow(s) {
  return {
    master_name: s.masterName,
    master_username: s.masterUsername,
    master_phone: s.masterPhone,
    slot_step_minutes: s.slotStepMinutes,
    booking_days_ahead: s.bookingDaysAhead,
    min_lead_minutes: s.minLeadMinutes,
    working_hours_text: s.workingHoursText,
    address: s.location.address,
    landmark: s.location.landmark,
    transport: s.location.transport,
    map_url: s.location.mapUrl,
    working_hours: s.workingHours,
    time_of_day: s.timeOfDay,
  };
}

function serviceToRow(s) {
  return {
    id: s.id,
    emoji: s.emoji,
    name: s.name,
    price: s.price,
    duration: s.duration,
    note: s.note,
    sort: s.sort,
    active: s.active,
  };
}

/* ─── Снапшот ───────────────────────────────────────────────────
   ⚠️ getSnapshot обязан возвращать ОДНУ И ТУ ЖЕ ссылку, пока ничего
   не менялось. Новый объект на каждый вызов — бесконечный цикл
   рендера, а не мелкая неоптимальность. Поэтому activeServices
   считается здесь, при записи, а не в геттере.                   */

let snapshot = EMPTY;
let started = false;
const listeners = new Set();

function publish(next) {
  snapshot = next;
  listeners.forEach((fn) => fn());
}

function withContent(base, content, extra) {
  const services = content.services ?? [];
  return {
    ...base,
    ...extra,
    settings: content.settings ?? null,
    services,
    activeServices: services.filter((s) => s.active),
    daysOff: content.daysOff ?? [],
    infoBlocks: content.infoBlocks ?? [],
  };
}

export function contentSnapshot() {
  return snapshot;
}

export function subscribeContent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useContent() {
  return useSyncExternalStore(subscribeContent, contentSnapshot, contentSnapshot);
}

/** Услуга по id — включая скрытые: у прошлой записи должно остаться название. */
export function findService(id) {
  return snapshot.services.find((s) => s.id === id) || null;
}

/* ─── Кэш ───────────────────────────────────────────────────────
   Читаем синхронно при загрузке модуля (как readStored в theme.js):
   тогда у вернувшегося клиента settings есть уже на первом кадре,
   и экран загрузки он не увидит вовсе.                           */

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.settings) return null;
    return {
      settings: parsed.settings,
      services: Array.isArray(parsed.services)
        ? parsed.services.filter((s) => s && s.id && s.name)
        : [],
      daysOff: Array.isArray(parsed.daysOff) ? parsed.daysOff : [],
      infoBlocks: Array.isArray(parsed.infoBlocks) ? parsed.infoBlocks : [],
    };
  } catch {
    return null; // повреждённые данные не должны ронять приложение
  }
}

function writeCache(content) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(content));
  } catch {
    // приватный режим — молча пропускаем
  }
}

const cached = readCache();
if (cached) {
  snapshot = withContent(EMPTY, cached, { status: "loading" });
}

/* ─── Загрузка ──────────────────────────────────────────────────── */

// Два быстрых сохранения дают две загрузки, ответы могут прийти
// в обратном порядке. Считаем актуальным только последний запрос.
let seq = 0;

export async function refreshContent() {
  if (!supabase) {
    publish({ ...snapshot, status: "error", error: NOT_CONFIGURED, stale: Boolean(snapshot.settings) });
    return;
  }

  const mine = ++seq;

  let result;
  try {
    result = await Promise.all([
      supabase.from("settings").select("*").eq("id", 1).maybeSingle(),
      supabase
        .from("services")
        .select("id,emoji,name,price,duration,note,sort,active")
        .order("sort", { ascending: true })
        .order("id", { ascending: true }),
      supabase.from("days_off").select("day").order("day", { ascending: true }),
      supabase
        .from("info_blocks")
        .select("id,emoji,title,body,sort")
        .order("sort", { ascending: true })
        .order("id", { ascending: true }),
    ]);
  } catch {
    if (mine !== seq) return;
    publish({
      ...snapshot,
      status: "error",
      error: "Нет связи с сервером",
      stale: Boolean(snapshot.settings),
    });
    return;
  }

  if (mine !== seq) return; // обогнал более свежий запрос

  const failed = result.find((r) => r.error);
  if (failed) {
    publish({
      ...snapshot,
      status: "error",
      error: failed.error.message || "Не удалось загрузить данные",
      stale: Boolean(snapshot.settings),
    });
    return;
  }

  const [settingsRes, servicesRes, daysRes, infoRes] = result;
  const content = {
    settings: toSettings(settingsRes.data),
    services: servicesRes.data ?? [],
    daysOff: (daysRes.data ?? []).map((r) => r.day),
    infoBlocks: infoRes.data ?? [],
  };

  if (!content.settings) {
    publish({
      ...snapshot,
      status: "error",
      error: "В базе нет строки настроек. Выполните supabase/schema.sql.",
      stale: Boolean(snapshot.settings),
    });
    return;
  }

  // Кэш пишем только при полном успехе: частичный ответ хуже устаревшего целого.
  writeCache(content);
  publish(withContent(snapshot, content, { status: "ready", error: null, stale: false }));
}

/**
 * Вызывать один раз при старте. Флаг started — защита от двойного
 * вызова эффекта под React.StrictMode.
 */
export function initContent() {
  if (started) return;
  started = true;
  refreshContent();
}

/* ─── Мутации: только для админки ───────────────────────────────
   Каждая на успехе перечитывает контент, поэтому подписанные экраны
   обновляются сами. Возвращаем { ok, error } — экрану не бросаем.  */

function fail(error) {
  return { ok: false, error: error?.message || "Не удалось сохранить" };
}

async function run(query) {
  if (!supabase) return { ok: false, error: NOT_CONFIGURED };
  try {
    const { error } = await query();
    if (error) return fail(error);
    await refreshContent();
    return { ok: true, error: null };
  } catch (e) {
    return fail(e);
  }
}

export function saveSettings(settings) {
  return run(() =>
    supabase.from("settings").update(settingsToRow(settings)).eq("id", 1)
  );
}

export function createService(fields) {
  return run(() =>
    supabase.from("services").insert({
      ...serviceToRow(fields),
      sort: (snapshot.services.length + 1) * 10,
    })
  );
}

export function updateService(id, fields) {
  const { id: _ignored, ...rest } = serviceToRow(fields);
  return run(() => supabase.from("services").update(rest).eq("id", id));
}

export function deleteService(id) {
  return run(() => supabase.from("services").delete().eq("id", id));
}

/** Переписываем позиции целиком — без обменов и коллизий. */
export function reorderServices(orderedIds) {
  const byId = new Map(snapshot.services.map((s) => [s.id, s]));
  const rows = orderedIds
    .map((id, i) => {
      const s = byId.get(id);
      return s ? { ...serviceToRow(s), sort: (i + 1) * 10 } : null;
    })
    .filter(Boolean);
  return run(() => supabase.from("services").upsert(rows, { onConflict: "id" }));
}

export function addDayOff(day) {
  return run(() => supabase.from("days_off").insert({ day }));
}

export function removeDayOff(day) {
  return run(() => supabase.from("days_off").delete().eq("day", day));
}

export function saveInfoBlock(block) {
  const row = {
    emoji: block.emoji,
    title: block.title,
    body: block.body,
    sort: block.sort ?? (snapshot.infoBlocks.length + 1) * 10,
  };
  if (block.id) {
    return run(() => supabase.from("info_blocks").update(row).eq("id", block.id));
  }
  return run(() => supabase.from("info_blocks").insert(row));
}

export function deleteInfoBlock(id) {
  return run(() => supabase.from("info_blocks").delete().eq("id", id));
}

export function reorderInfoBlocks(orderedIds) {
  const byId = new Map(snapshot.infoBlocks.map((b) => [b.id, b]));
  const rows = orderedIds
    .map((id, i) => {
      const b = byId.get(id);
      return b ? { ...b, sort: (i + 1) * 10 } : null;
    })
    .filter(Boolean);
  return run(() =>
    supabase.from("info_blocks").upsert(rows, { onConflict: "id" })
  );
}

/* ─── Идентификатор новой услуги ────────────────────────────────
   Латиницей, без пробелов — по нему находятся сохранённые у клиентов
   заявки. У существующих услуг он не меняется (поле disabled).     */

const RU = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
  з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c",
  ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
  я: "ya",
};

export function slugify(name, taken = []) {
  const base =
    [...String(name).toLowerCase()]
      .map((ch) => RU[ch] ?? ch)
      .join("")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 28) || "service";
  const start = /^[a-z]/.test(base) ? base : `s_${base}`.slice(0, 30);
  if (!taken.includes(start)) return start;
  for (let n = 2; n < 100; n++) {
    const candidate = `${start}_${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${start}_${Date.now().toString(36).slice(-4)}`;
}

/* ─── Валидация ─────────────────────────────────────────────────
   Повторяет check-и из supabase/schema.sql, чтобы владелица видела
   русский текст, а не сырую ошибку Postgres.                      */

const isInt = (v) => /^\d+$/.test(String(v).trim());

/** Первое нарушенное правило или null. */
export function validateService(f, taken = []) {
  const name = String(f.name ?? "").trim();
  if (name.length < 1 || name.length > 80) return "Введите название услуги";
  if (!isInt(f.price) || Number(f.price) > 9999)
    return "Цена — целое число от 0 до 9999";
  if (!isInt(f.duration)) return "Длительность — целое число минут";
  const dur = Number(f.duration);
  if (dur < 15 || dur > 600 || dur % 15 !== 0)
    return "Длительность — от 15 до 600 минут, кратно 15";
  if (String(f.note ?? "").length > 120) return "Описание слишком длинное";
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(f.id ?? ""))
    return "Идентификатор: латиница, цифры и _, начинается с буквы";
  if (taken.includes(f.id)) return "Такой идентификатор уже занят";
  return null;
}

export function validateSettings(s) {
  if (!String(s.masterName ?? "").trim()) return "Введите имя мастера";
  if (!/^[A-Za-z0-9_]{0,32}$/.test(s.masterUsername ?? ""))
    return "Логин Telegram: латиница, цифры и _, без @";

  for (let dow = 0; dow < 7; dow++) {
    const h = s.workingHours?.[dow];
    if (!h) continue;
    if (!/^\d{2}:\d{2}$/.test(h.from) || !/^\d{2}:\d{2}$/.test(h.to))
      return "Время работы указывается как ЧЧ:ММ";
    if (h.from >= h.to)
      return "Начало рабочего дня должно быть раньше окончания";
  }
  return null;
}
