// Весь контент салона: услуги, график, адрес, тексты.
//
// Это рантайм-замена прежнего src/data.js. Раньше контент был набором
// констант, которые Vite инлайнил при сборке; теперь он лежит в Supabase.
// Клиент отсюда только ЧИТАЕТ — правки делает мастер в отдельном
// приложении, кабинете мастера (admin.html, src/admin/), у которого свой
// стор (src/admin/store.js) и свои запросы на запись (src/admin/api.js).
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
