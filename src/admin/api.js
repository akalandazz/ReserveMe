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
    const { data, error } = await query();
    if (error) return fail(error);
    await loadAdminData();
    return { ok: true, error: null, data };
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

/** Запись, которую заводит сам мастер: сразу подтверждённая, мимо «Заявок».
 *  clientId — существующий клиент; иначе newName/newPhone создают нового
 *  в той же транзакции (см. create_master_booking в schema.sql). */
export function createMasterBooking({ clientId, newName, newPhone, serviceId, day, startMin }) {
  return run(() =>
    supabase.rpc("create_master_booking", {
      p_client_id: clientId ?? null,
      p_new_name: newName ?? "",
      p_new_phone: newPhone ?? "",
      p_service_id: serviceId,
      p_day: day,
      p_start_min: startMin,
    })
  );
}

/** Свободные старты под услугу на дату — считает сервер (free_slots).
 *  Только чтение, поэтому без loadAdminData. */
export async function fetchFreeSlots(day, serviceId) {
  if (!supabase) return { ok: false, error: NOT_CONFIGURED, slots: [] };
  try {
    const { data, error } = await supabase.rpc("free_slots", {
      p_day: day,
      p_service_id: serviceId,
    });
    if (error) return { ...fail(error), slots: [] };
    return { ok: true, error: null, slots: (data ?? []).map((r) => r.start_min) };
  } catch (e) {
    return { ...fail(e), slots: [] };
  }
}

/* ─── Клиенты ───────────────────────────────────────────────────── */

/** Юзернейм без @ и пробелов — так он хранится и так сопоставляется
 *  с заявками в link_booking_client(). */
export function normalizeUsername(value) {
  return String(value ?? "").trim().replace(/^@+/, "");
}

function clientFields({ name, telegram_username, phone }) {
  return {
    name: String(name ?? "").trim(),
    telegram_username: normalizeUsername(telegram_username),
    phone: String(phone ?? "").trim(),
  };
}

// Уникальный индекс clients_username_uq — два клиента с одним телеграмом.
function clientResult(res) {
  if (!res.ok && /clients_username_uq|duplicate key/.test(res.error)) {
    return { ...res, error: "Клиент с таким Telegram уже есть." };
  }
  return res;
}

export async function createClient(fields) {
  const res = await run(() =>
    supabase.from("clients").insert(clientFields(fields)).select("id").single()
  );
  return clientResult({ ...res, id: res.data?.id ?? null });
}

export async function updateClient(id, fields) {
  return clientResult(
    await run(() => supabase.from("clients").update(clientFields(fields)).eq("id", id))
  );
}

export function addClientComment(clientId, body) {
  return run(() =>
    supabase.from("client_comments").insert({ client_id: clientId, body: body.trim() })
  );
}

export function deleteClientComment(id) {
  return run(() => supabase.from("client_comments").delete().eq("id", id));
}
