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
  clients: [],
  comments: [], // client_comments, новые сверху
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
      // Без визитов — сверху: это новые клиенты, в том числе только
      // что заведённый мастером, которого она сейчас заполняет.
      supabase
        .from("client_stats")
        .select("*")
        .order("last_visit_at", { ascending: false, nullsFirst: true })
        .order("created_at", { ascending: false }),
      supabase
        .from("client_comments")
        .select("id,client_id,body,created_at")
        .order("created_at", { ascending: false }),
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

  const [settingsRes, servicesRes, daysRes, blockedRes, bookingsRes, clientsRes, commentsRes] =
    result;
  const clients = clientsRes.data ?? [];
  publish({
    status: "ready",
    error: null,
    settings: toAdminSettings(settingsRes.data),
    services: servicesRes.data ?? [],
    daysOff: (daysRes.data ?? []).map((r) => r.day),
    blockedSlots: blockedRes.data ?? [],
    bookings: withClientNames(bookingsRes.data ?? [], clients),
    clients,
    comments: commentsRes.data ?? [],
  });
}

/**
 * Имя и юзернейм на записи — от клиента по client_id, а не из
 * client_name/client_username самой строки: те застывают в момент
 * заявки, а мастер переименовывает клиента в «Клиенты», и новое имя
 * должно появиться везде — в панели дня, в неделе, в заявках.
 * Запись без client_id (клиент не определился) показывает своё.
 */
function withClientNames(bookings, clients) {
  const byId = new Map(clients.map((c) => [c.id, c]));
  return bookings.map((b) => {
    const c = b.client_id != null ? byId.get(b.client_id) : null;
    if (!c) return b;
    return {
      ...b,
      client_name: c.name || b.client_name,
      client_username: c.telegram_username,
    };
  });
}

/** При выходе — иначе следующий вошедший на миг увидит чужие данные. */
export function resetAdminData() {
  seq++; // отменяем недошедший запрос
  publish(EMPTY);
}
