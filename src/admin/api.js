// Запросы кабинета мастера: услуги, график, дни без записи, закрытые
// окошки, записи клиентов. Каждая мутация на успехе перечитывает данные
// (loadAdminData) — подписанные компоненты обновляются сами, как в
// src/content.js. Никогда не бросает — всегда { ok, error }.

import { NOT_CONFIGURED, supabase } from "../supabase.js";
import { loadAdminData } from "./store.js";

function fail(error) {
  return { ok: false, error: error?.message || "Не удалось сохранить" };
}

async function run(query) {
  if (!supabase) return { ok: false, error: NOT_CONFIGURED };
  try {
    const { error } = await query();
    if (error) return fail(error);
    await loadAdminData();
    return { ok: true, error: null };
  } catch (e) {
    return fail(e);
  }
}

/* ─── Услуги ────────────────────────────────────────────────────
   Кабинет правит только name/price/duration — макет не знает про
   emoji/note/active. Их не трогаем: при создании услуги эти колонки
   берут значение по умолчанию, при правке — остаются как были,
   потому что не входят в отправляемый объект.                     */

export function createService({ name, price, duration }) {
  // Латиницей и цифрами — проходит check (id ~ '^[a-z][a-z0-9_]{1,31}$').
  const id = "svc" + Date.now().toString(36);
  return run(() => supabase.from("services").insert({ id, name, price, duration }));
}

export function updateService(id, { name, price, duration }) {
  return run(() =>
    supabase.from("services").update({ name, price, duration }).eq("id", id)
  );
}

export function deleteService(id) {
  return run(() => supabase.from("services").delete().eq("id", id));
}

/** Первое нарушенное правило (те же ограничения, что в schema.sql) или null. */
export function validateServiceFields(s) {
  const name = String(s.name ?? "").trim();
  if (!name || name.length > 80) return "Введите название услуги";
  const price = Number(s.price);
  if (!Number.isInteger(price) || price < 0 || price > 9999)
    return "Цена — целое число от 0 до 9999";
  const duration = Number(s.duration);
  if (!Number.isInteger(duration) || duration < 15 || duration > 600 || duration % 15 !== 0)
    return "Длительность — от 15 до 600 минут, кратно 15";
  return null;
}

/* ─── График ────────────────────────────────────────────────────── */

export function saveWorkingHours(workingHours) {
  return run(() =>
    supabase.from("settings").update({ working_hours: workingHours }).eq("id", 1)
  );
}

/* ─── Дни без записи ────────────────────────────────────────────── */

export function closeDay(day) {
  return run(() => supabase.from("days_off").insert({ day }));
}

export function openDay(day) {
  return run(() => supabase.from("days_off").delete().eq("day", day));
}

/* ─── Закрытые окошки ───────────────────────────────────────────── */

export function blockSlot(day, startMin) {
  return run(() => supabase.from("blocked_slots").insert({ day, start_min: startMin }));
}

export function unblockSlot(day, startMin) {
  return run(() =>
    supabase.from("blocked_slots").delete().eq("day", day).eq("start_min", startMin)
  );
}

/* ─── Записи ────────────────────────────────────────────────────── */

export function approveBooking(id) {
  return run(() => supabase.from("bookings").update({ status: "ok" }).eq("id", id));
}

export function deleteBooking(id) {
  return run(() => supabase.from("bookings").delete().eq("id", id));
}

export function moveBooking(id, day, startMin) {
  return run(() =>
    supabase.from("bookings").update({ day, start_min: startMin }).eq("id", id)
  );
}
