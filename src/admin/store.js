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
  bookings: [], // без отменённых — см. splitBookings()
  cancellations: [], // отмены клиентов, которые мастер ещё не видела
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

// PostgREST отдаёт не больше max_rows строк за запрос (в Supabase по
// умолчанию 1000, но его можно и уменьшить) и молча обрезает остальное.
// Растущие таблицы читаем страницами до числа строк, которое первый
// запрос посчитал на сервере, — а не «пока страница не придёт неполной»:
// при max_rows меньше PAGE первая же страница выглядела бы последней.
// build(opts) должен задавать однозначный порядок (с id в конце) —
// иначе страницы перекроются.
const PAGE = 1000;

async function selectAll(build) {
  const rows = [];
  let total = null;
  for (;;) {
    const query = total === null ? build({ count: "exact" }) : build();
    const res = await query.range(rows.length, rows.length + PAGE - 1);
    if (res.error) return res;
    const page = res.data ?? [];
    if (total === null) total = res.count ?? Infinity;
    rows.push(...page);
    if (!page.length || rows.length >= total) break;
  }
  // Страницы — отдельные запросы: строка, вставленная между ними раньше
  // по порядку, сдвигает смещение, и последняя строка прошлой страницы
  // приходит второй раз. Дубль убираем здесь; строка, которую так
  // «перешагнули», появится при следующей загрузке.
  const seen = new Set();
  const data = rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  return { data, error: null };
}

// Части снапшота и откуда каждая читается. Мутации в api.js
// перечитывают только те части, которые меняли: заметка к клиенту не
// должна тянуть за собой всю историю записей.
const LOADERS = {
  settings: () =>
    supabase
      .from("settings")
      .select("master_name,slot_step_minutes,working_hours")
      .eq("id", 1)
      .maybeSingle(),
  services: () =>
    supabase
      .from("services")
      .select("*")
      .order("sort", { ascending: true })
      .order("id", { ascending: true }),
  daysOff: () => supabase.from("days_off").select("day").order("day", { ascending: true }),
  blockedSlots: () => supabase.from("blocked_slots").select("day,start_min"),
  bookings: () =>
    selectAll((opts) =>
      supabase
        .from("bookings")
        .select("*", opts)
        .order("day", { ascending: true })
        .order("start_min", { ascending: true })
        .order("id", { ascending: true })
    ),
  // Без визитов — сверху: это новые клиенты, в том числе только
  // что заведённый мастером, которого она сейчас заполняет.
  clients: () =>
    selectAll((opts) =>
      supabase
        .from("client_stats")
        .select("*", opts)
        .order("last_visit_at", { ascending: false, nullsFirst: true })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
    ),
  comments: () =>
    selectAll((opts) =>
      supabase
        .from("client_comments")
        .select("id,client_id,body,created_at", opts)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
    ),
};

const PARTS = Object.keys(LOADERS);

const PARSE = {
  settings: toAdminSettings,
  daysOff: (rows) => (rows ?? []).map((r) => r.day),
};

// Записи как пришли из базы, до withClientNames: перечитали только
// клиентов (переименование) — имена на записях пересчитываются из них.
let rawBookings = [];

// Два быстрых обновления дают два запроса, ответы могут прийти в
// обратном порядке. Актуален только последний — по каждой части
// отдельно, чтобы перечитка комментариев не отменяла перечитку записей.
const seq = Object.fromEntries(PARTS.map((p) => [p, 0]));

/**
 * Перечитать данные кабинета. parts — какие части снапшота (ключи
 * LOADERS); по умолчанию все. Пока снапшот не "ready", читается всё:
 * частичная загрузка поверх пустого или сломанного снапшота показала
 * бы кабинет без половины данных.
 */
export async function loadAdminData(parts = PARTS) {
  if (!supabase) {
    publish({ ...EMPTY, status: "error", error: NOT_CONFIGURED });
    return;
  }

  if (snapshot.status !== "ready") {
    parts = PARTS;
    publish({ ...snapshot, status: snapshot.settings ? snapshot.status : "loading" });
  }
  const tickets = parts.map((p) => ++seq[p]);
  const isFresh = (i) => seq[parts[i]] === tickets[i];

  let results;
  try {
    results = await Promise.all(parts.map((p) => LOADERS[p]()));
  } catch {
    if (!parts.some((_, i) => isFresh(i))) return;
    publish({ ...snapshot, status: "error", error: "Нет связи с сервером" });
    return;
  }

  // Части, которые обогнал более свежий запрос, отбрасываем.
  const fresh = parts.flatMap((p, i) => (isFresh(i) ? [[p, results[i]]] : []));
  if (!fresh.length) return;

  const failed = fresh.find(([, r]) => r.error);
  if (failed) {
    publish({
      ...snapshot,
      status: "error",
      error: failed[1].error.message || "Не удалось загрузить данные",
    });
    return;
  }

  const next = { ...snapshot, status: "ready", error: null };
  for (const [p, r] of fresh) {
    if (p === "bookings") rawBookings = r.data ?? [];
    else next[p] = PARSE[p] ? PARSE[p](r.data) : (r.data ?? []);
  }
  // Ссылка на bookings меняется, только если менялись записи или клиенты,
  // — иначе useMemo по bookings в секциях пересчитывался бы зря.
  if (fresh.some(([p]) => p === "bookings" || p === "clients")) {
    Object.assign(next, splitBookings(withClientNames(rawBookings, next.clients)));
  }
  publish(next);
}

/**
 * Отменённые записи (status "cancelled") остаются в базе — по ним клиент
 * узнаёт об отмене (booking_status), — но кабинету они не записи: ни в
 * календаре, ни в статистике, ни в «Клиентах», и время они не занимают.
 * Отсекаем их здесь, одним местом, а не в каждой секции. Наружу выходят
 * только отмены клиентов, которых мастер ещё не видела, — для блока
 * «Отмены» в «Заявках».
 */
function splitBookings(all) {
  const bookings = [];
  const cancellations = [];
  for (const b of all) {
    if (b.status !== "cancelled") bookings.push(b);
    else if (b.cancelled_by === "client" && !b.cancel_seen) cancellations.push(b);
  }
  return { bookings, cancellations };
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
  for (const p of PARTS) seq[p]++; // отменяем недошедшие запросы
  rawBookings = [];
  publish(EMPTY);
}
