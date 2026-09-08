// Стор данных кабинета мастера: услуги, график, дни без записи,
// закрытые окошки, записи клиентов.
//
// Та же идиома, что у src/content.js и src/supabase.js: снапшот —
// объект на уровне модуля, useSyncExternalStore получает ОДНУ И ТУ ЖЕ
// ссылку, пока ничего не менялось. Новый объект на каждый вызов
// getSnapshot — бесконечный цикл рендера.
//
// В отличие от content.js эти данные читает только вошедший мастер:
// RLS не пускает анонима к bookings вовсе (см. supabase/schema.sql),
// поэтому loadAdminData вызывают только после useSession().status
// === "signed" — см. AdminApp.jsx.

import { useSyncExternalStore } from "react";
import { NOT_CONFIGURED, supabase } from "../supabase.js";

const EMPTY = {
  status: "idle", // idle -> loading -> ready | error
  error: null,
  settings: null,
  services: [],
  daysOff: [],
  blockedSlots: [],
  bookings: [],
};

let snapshot = EMPTY;
const listeners = new Set();

function publish(next) {
  snapshot = next;
  listeners.forEach((fn) => fn());
}

export function adminSnapshot() {
  return snapshot;
}

export function subscribeAdmin(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAdminData() {
  return useSyncExternalStore(subscribeAdmin, adminSnapshot, adminSnapshot);
}

/** Из настроек кабинету нужны только имя (шапка), шаг сетки и график. */
function toAdminSettings(row) {
  if (!row) return null;
  return {
    masterName: row.master_name ?? "",
    slotStepMinutes: Number(row.slot_step_minutes) || 30,
    workingHours: row.working_hours ?? {},
  };
}

// Два быстрых обновления дают два запроса, ответы могут прийти в
// обратном порядке. Актуален только последний.
let seq = 0;

export async function loadAdminData() {
  if (!supabase) {
    publish({ ...EMPTY, status: "error", error: NOT_CONFIGURED });
    return;
  }

  publish({ ...snapshot, status: snapshot.settings ? snapshot.status : "loading" });
  const mine = ++seq;

  let result;
  try {
    result = await Promise.all([
      supabase
        .from("settings")
        .select("master_name,slot_step_minutes,working_hours")
        .eq("id", 1)
        .maybeSingle(),
      supabase
        .from("services")
        .select("*")
        .order("sort", { ascending: true })
        .order("id", { ascending: true }),
      supabase.from("days_off").select("day").order("day", { ascending: true }),
      supabase.from("blocked_slots").select("day,start_min"),
      supabase
        .from("bookings")
        .select("*")
        .order("day", { ascending: true })
        .order("start_min", { ascending: true }),
    ]);
  } catch {
    if (mine !== seq) return;
    publish({ ...snapshot, status: "error", error: "Нет связи с сервером" });
    return;
  }

  if (mine !== seq) return; // обогнал более свежий запрос

  const failed = result.find((r) => r.error);
  if (failed) {
    publish({
      ...snapshot,
      status: "error",
      error: failed.error.message || "Не удалось загрузить данные",
    });
    return;
  }

  const [settingsRes, servicesRes, daysRes, blockedRes, bookingsRes] = result;
  publish({
    status: "ready",
    error: null,
    settings: toAdminSettings(settingsRes.data),
    services: servicesRes.data ?? [],
    daysOff: (daysRes.data ?? []).map((r) => r.day),
    blockedSlots: blockedRes.data ?? [],
    bookings: bookingsRes.data ?? [],
  });
}

/** При выходе — иначе следующий вошедший на миг увидит чужие данные. */
export function resetAdminData() {
  seq++; // отменяем недошедший запрос
  publish(EMPTY);
}
