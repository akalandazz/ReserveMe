// Записи клиента — только на сервере.
//
// Источник правды — таблица bookings: клиент читает свои строки (RLS
// bookings_select_own, user_id = auth.uid()), вставляет новую заявку и
// отменяет свою запись через cancel_own_booking(id). Никакой копии на
// устройстве: вошёл с другого телефона — видит те же записи.
//
// Стор — та же идиома, что у content.js: useSyncExternalStore и
// ОДНА И ТА ЖЕ ссылка на снапшот, пока ничего не менялось.
//
// Решение мастера (подтвердила, перенесла, отменила) клиент узнаёт
// тостом — push-канала к нему нет. Чтобы понять, что изменилось, стор
// помнит, какой каждую запись клиент уже видел (SEEN_KEY, по аккаунту).
// Это не копия записей, а только «что уже показано»: пропадёт — клиент
// просто не увидит один тост.

import { useSyncExternalStore } from "react";
import { isPast, labelForKey, toHHMM, toMinutes } from "./schedule.js";
import { NOT_CONFIGURED, currentUserId, supabase, withTimeout } from "./supabase.js";

const SEEN_KEY = "vs_seen_v1";
const COLS =
  "id,day,start_min,duration,price,service_id,service_name,comment,status,cancelled_by";
// Прошлое клиенту нужно только для «Прошедших» — хватит последних.
const LIMIT = 100;
const TIMEOUT_MS = 5000;

const EMPTY = { status: "loading", error: null, stale: false, list: [] };

let snapshot = EMPTY;
let owner = null; // чьи записи лежат в снапшоте
let seen = null; // id → отпечаток, см. fingerprint()
const listeners = new Set();

function publish(next) {
  snapshot = next;
  listeners.forEach((fn) => fn());
}

export function bookingsSnapshot() {
  return snapshot;
}

export function subscribeBookings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useMyBookings() {
  return useSyncExternalStore(subscribeBookings, bookingsSnapshot, bookingsSnapshot);
}

/* ─── Нормализация ──────────────────────────────────────────────
   snake_case дальше стора не уходит.                              */

function toBooking(r) {
  return {
    id: r.id,
    serviceId: r.service_id ?? null,
    serviceName: r.service_name ?? "",
    day: r.day,
    time: toHHMM(Number(r.start_min) || 0),
    duration: Number(r.duration) || 0,
    price: Number(r.price) || 0,
    comment: r.comment ?? "",
    status: r.status,
    cancelledBy: r.cancelled_by ?? "",
  };
}

// Отменённое самим клиентом ему больше не показываем; отменённое
// мастером — показываем, пока не прошёл день записи.
const visible = (b) =>
  b.status === "cancelled" ? b.cancelledBy === "master" && !isPast(b) : true;

const byTime = (a, b) => (a.day + a.time < b.day + b.time ? -1 : 1);

function withList(list, extra) {
  return { ...snapshot, ...extra, list: list.filter(visible).sort(byTime) };
}

/* ─── «Уже видел» ────────────────────────────────────────────────── */

const fingerprint = (b) => ({
  st: b.status,
  d: b.day,
  t: b.time,
  m: b.duration,
  p: b.price,
  s: b.serviceId,
});

function readSeen(uid) {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${SEEN_KEY}:${uid}`) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSeen(uid, map) {
  try {
    localStorage.setItem(`${SEEN_KEY}:${uid}`, JSON.stringify(map));
  } catch {
    // приватный режим — тосты просто не переживут перезапуск
  }
}

/** Что изменилось с прошлого раза — для тоста. Новые записи не в счёт:
 *  о них клиент знает и так (или впервые открыл мини-апп на устройстве). */
function diff(prev, rows) {
  const changes = [];
  const ids = new Set();
  for (const b of rows) {
    ids.add(String(b.id));
    const was = prev[b.id];
    if (!was || isPast(b)) continue;
    if (b.status === "cancelled") {
      if (was.st !== "cancelled" && b.cancelledBy === "master") changes.push({ ...b, kind: "cancelled" });
    } else if (was.d !== b.day || was.t !== b.time) {
      // Перенос важнее подтверждения: сохранение в листе мастера делает
      // и то, и другое, а клиенту главное — новое время.
      changes.push({ ...b, kind: "time" });
    } else if (was.m !== b.duration || was.p !== b.price || was.s !== b.serviceId) {
      changes.push({ ...b, kind: "details" });
    } else if (was.st !== b.status && b.status === "ok") {
      changes.push({ ...b, kind: "ok" });
    }
  }
  // Строка пропала — мастер удалила клиента вместе с записями.
  for (const [id, was] of Object.entries(prev)) {
    if (ids.has(id) || was.st === "cancelled") continue;
    const b = { day: was.d, time: was.t };
    if (!isPast(b)) changes.push({ ...b, kind: "cancelled" });
  }
  return changes;
}

/* ─── Загрузка ──────────────────────────────────────────────────── */

let seq = 0;
let inflight = null;

/**
 * Перечитать свои записи. Одновременные вызовы (главная, «Мои записи»,
 * возврат во вкладку, опрос) сливаются в один запрос.
 * @returns {Promise<{ ok: boolean, changes: object[] }>}
 */
export function refreshMyBookings() {
  if (!inflight) {
    inflight = load().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function load() {
  const uid = currentUserId();
  if (!supabase || !uid) {
    publish({ ...snapshot, status: "error", error: NOT_CONFIGURED });
    return { ok: false, changes: [] };
  }
  if (owner !== uid) {
    owner = uid;
    seen = readSeen(uid);
    publish(EMPTY);
  }
  const mine = ++seq;

  const res = await withTimeout(
    supabase
      .from("bookings")
      .select(COLS)
      // RLS и так отдаёт клиенту только его строки, но мастер,
      // открывшая мини-апп своим аккаунтом, увидела бы все.
      .eq("user_id", uid)
      .order("day", { ascending: false })
      .order("start_min", { ascending: false })
      .limit(LIMIT),
    TIMEOUT_MS
  );
  if (mine !== seq || owner !== uid) return { ok: false, changes: [] };

  if (!res || res.error || !Array.isArray(res.data)) {
    publish({
      ...snapshot,
      status: snapshot.status === "ready" ? "ready" : "error",
      error: "Не удалось загрузить записи",
      stale: snapshot.status === "ready",
    });
    return { ok: false, changes: [] };
  }

  const rows = res.data.map(toBooking);
  const changes = diff(seen, rows);
  seen = Object.fromEntries(rows.map((b) => [b.id, fingerprint(b)]));
  writeSeen(uid, seen);
  publish(withList(rows, { status: "ready", error: null, stale: false }));
  return { ok: true, changes };
}

/** Выход из аккаунта: чужие записи не должны мелькнуть следующему. */
export function resetMyBookings() {
  seq++;
  owner = null;
  seen = null;
  publish(EMPTY);
}

/* ─── Запись и отмена ───────────────────────────────────────────── */

/** Текст ошибки для клиента. Отказы guard_client_booking() (schema.sql)
 *  уже по-русски — их и показываем. */
function writeError(res, fallback = "Не удалось сохранить заявку. Попробуйте ещё раз.") {
  if (!res) return "Нет связи с сервером. Попробуйте ещё раз.";
  if (res.error?.code === "P0001" && res.error.message) return res.error.message;
  // 42501 — сервер не признал запись своей или вход (403): не наш текст
  // базы, а понятный клиенту.
  if (res.error?.code === "42501") return "Нет доступа. Закройте приложение и откройте его заново.";
  return fallback;
}

/** Свежая строка с сервера — сразу в стор и в «уже видел»: экран покажет
 *  её без запроса, а следующая загрузка не примет её за изменение. */
function storeRow(uid, row) {
  const b = toBooking(row);
  if (owner === uid && seen) {
    seen = { ...seen, [b.id]: fingerprint(b) };
    writeSeen(uid, seen);
    publish(withList([...snapshot.list.filter((x) => x.id !== b.id), b], {}));
  }
}

/**
 * Новая заявка. Вызывается из BookingScreen.submit() ДО sendToMaster
 * (openTelegramLink закрывает мини-апп) и ждёт ответа: без строки в
 * базе заявки нет — ни у мастера в кабинете, ни у клиента в «Мои записи».
 * Длительность, цену, название, имя, юзернейм и user_id ставит сервер
 * (guard_client_booking) — поэтому они и не отправляются.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function createBooking({ service, day, time, comment }) {
  const uid = currentUserId();
  if (!supabase || !uid) return { ok: false, error: NOT_CONFIGURED };
  const res = await withTimeout(
    supabase
      .from("bookings")
      .insert({
        day,
        start_min: toMinutes(time),
        duration: service.duration,
        price: service.price,
        service_id: service.id,
        service_name: service.name,
        comment,
        status: "new",
        source: "client",
      })
      .select(COLS)
      .single(),
    TIMEOUT_MS
  );
  if (!res || res.error || !res.data) return { ok: false, error: writeError(res) };
  storeRow(uid, res.data);
  return { ok: true, error: null };
}

/**
 * Перенос своей записи — reschedule_own_booking (schema.sql): сервер
 * проверяет, что запись своя и новое время есть в расписании, и
 * возвращает её в «Заявки» (status "new"). Как и createBooking — ДО
 * sendToMaster.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function rescheduleMyBooking({ id, day, time }) {
  const uid = currentUserId();
  if (!supabase || !uid) return { ok: false, error: NOT_CONFIGURED };
  const res = await withTimeout(
    supabase
      .rpc("reschedule_own_booking", { p_id: id, p_day: day, p_start_min: toMinutes(time) })
      .select(COLS)
      .single(),
    TIMEOUT_MS
  );
  if (!res || res.error || !res.data) {
    return { ok: false, error: writeError(res, "Не удалось перенести запись. Попробуйте ещё раз.") };
  }
  storeRow(uid, res.data);
  return { ok: true, error: null };
}

/**
 * Отмена своей записи — cancel_own_booking (schema.sql): строка остаётся
 * со статусом "cancelled", мастер видит её в «Заявках» → «Отмены».
 * @returns {Promise<boolean>} true — сервер отметил отмену.
 */
export async function cancelMyBooking(id) {
  const uid = currentUserId();
  if (!supabase || !uid) return false;
  const res = await withTimeout(supabase.rpc("cancel_own_booking", { p_id: id }), TIMEOUT_MS);
  const ok = !!res && !res.error && res.data === true;
  if (ok && owner === uid) {
    if (seen?.[id]) {
      seen = { ...seen, [id]: { ...seen[id], st: "cancelled" } };
      writeSeen(uid, seen);
    }
    publish({ ...snapshot, list: snapshot.list.filter((b) => b.id !== id) });
  }
  return ok;
}

/* ─── Тост ──────────────────────────────────────────────────────── */

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** Текст тоста о решении мастера, или "" если сказать нечего. */
export function changesToast(changes) {
  if (changes.length === 0) return "";
  if (changes.length > 1) return "Ваши записи обновились — загляните в «Мои записи».";
  const [b] = changes;
  const when = `${lower(labelForKey(b.day))}, ${b.time}`;
  if (b.kind === "time") return `Мастер перенесла запись: ${when}`;
  if (b.kind === "details") return `Мастер изменила запись: ${when}`;
  if (b.kind === "ok") return `Запись подтверждена ✓ ${when}`;
  return `Мастер отменила запись: ${when}`;
}
