// Запросы кабинета мастера: услуги, график, дни без записи, закрытые
// окошки, записи клиентов. Каждая мутация на успехе перечитывает те
// части данных, которые могла изменить (loadAdminData(parts)), —
// подписанные компоненты обновляются сами, как в src/content.js.
// Никогда не бросает — всегда { ok, error }.

import { NOT_CONFIGURED, supabase } from "../supabase.js";
import { loadAdminData } from "./store.js";

function fail(error) {
  // Ограничение bookings_no_overlap_ok (schema.sql) — последняя линия
  // защиты от двух подтверждённых записей на одно время; его текст
  // Postgres пишет по-английски.
  if (/bookings_no_overlap_ok/.test(error?.message ?? "")) {
    return { ok: false, error: "Это время уже занято подтверждённой записью — выберите другое" };
  }
  return { ok: false, error: error?.message || "Не удалось сохранить" };
}

// Что перечитать после мутации (ключи LOADERS в store.js).
// Запись меняет client_stats (визиты, любимая услуга, новый клиент из
// create/update_master_booking), поэтому вместе с bookings — clients.
const BOOKINGS = ["bookings", "clients"];
// Переименование клиента — имена на записях пересчитываются в store.js
// из уже загруженных записей, bookings перечитывать не нужно.
const CLIENTS = ["clients"];
// favorite_service_name в client_stats берётся из services.
const SERVICES = ["services", "clients"];

async function run(query, parts) {
  if (!supabase) return { ok: false, error: NOT_CONFIGURED };
  try {
    const { data, error } = await query();
    if (error) return fail(error);
    await loadAdminData(parts);
    return { ok: true, error: null, data };
  } catch (e) {
    return fail(e);
  }
}

/* ─── Услуги ────────────────────────────────────────────────────
   Кабинет правит name/price/duration/note — макет не знает про
   emoji/active. Их не трогаем: при создании услуги эти колонки
   берут значение по умолчанию, при правке — остаются как были,
   потому что не входят в отправляемый объект. sort — порядок в списке
   (кабинет и клиент читают order by sort, id).                     */

export function createService({ name, price, duration, note, sort }) {
  // Латиницей и цифрами — проходит check (id ~ '^[a-z][a-z0-9_]{1,31}$').
  const id = "svc" + Date.now().toString(36);
  return run(
    () => supabase.from("services").insert({ id, name, price, duration, note, sort }),
    ["services"]
  );
}

export function updateService(id, { name, price, duration, note, sort }) {
  return run(
    () => supabase.from("services").update({ name, price, duration, note, sort }).eq("id", id),
    SERVICES
  );
}

/** service_id записей уходит в null (on delete set null) — перечитываем и их. */
export function deleteService(id) {
  return run(() => supabase.from("services").delete().eq("id", id), [...SERVICES, "bookings"]);
}

/** Первое нарушенное правило (те же ограничения, что в schema.sql) или null. */
export function validateServiceFields(s) {
  const name = String(s.name ?? "").trim();
  if (!name || name.length > 80) return "Введите название услуги";
  const price = Number(s.price);
  if (!Number.isInteger(price) || price < 0 || price > 99999)
    return "Цена — целое число от 0 до 99 999 ₽";
  const duration = Number(s.duration);
  if (!Number.isInteger(duration) || duration < 5 || duration > 600 || duration % 5 !== 0)
    return "Длительность — от 5 до 600 минут, кратно 5";
  if (String(s.note ?? "").trim().length > 120) return "Комментарий — до 120 символов";
  return null;
}

/* ─── График ────────────────────────────────────────────────────── */

// Строка settings мастера — одна на салон, другую RLS не покажет и не даст
// изменить. Фильтр — только потому, что update без фильтра PostgREST не шлёт.
const ownSettings = (row) => supabase.from("settings").update(row).not("salon_id", "is", null);

export function saveWorkingHours(workingHours) {
  return run(() => ownSettings({ working_hours: workingHours }), ["settings"]);
}

/** За сколько часов бот напоминает клиенту о записи; 0 — не напоминает. */
export function saveReminderHours(hours) {
  const h = Number(hours);
  if (!Number.isInteger(h) || h < 0 || h > 72) {
    return Promise.resolve({ ok: false, error: "Напоминание — от 0 до 72 часов" });
  }
  return run(() => ownSettings({ reminder_hours: h }), ["settings"]);
}

/* ─── Салон: профиль, адрес, правила записи ─────────────────────── */

// Ключ из toAdminSettings (store.js) → колонка settings.
const SETTINGS_COLUMNS = {
  masterName: "master_name",
  masterUsername: "master_username",
  masterPhone: "master_phone",
  address: "address",
  landmark: "landmark",
  transport: "transport",
  mapUrl: "map_url",
  workingHoursText: "working_hours_text",
  slotStepMinutes: "slot_step_minutes",
  bookingDaysAhead: "booking_days_ahead",
  minLeadMinutes: "min_lead_minutes",
};

// settings_slot_step_minutes_check в schema.sql.
export const SLOT_STEPS = [5, 10, 15, 20, 30, 60];

const NUMERIC_SETTINGS = new Set(["slotStepMinutes", "bookingDaysAhead", "minLeadMinutes"]);

/** Обрезает пробелы, снимает «@» с логина, числа — в числа. Только переданные ключи. */
export function normalizeSettingsFields(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in SETTINGS_COLUMNS)) continue;
    if (NUMERIC_SETTINGS.has(key)) out[key] = Number(value);
    else if (key === "masterUsername") out[key] = String(value ?? "").trim().replace(/^@+/, "");
    else out[key] = String(value ?? "").trim();
  }
  return out;
}

/** Первое нарушенное правило (те же ограничения, что в schema.sql) или null. */
export function validateSettingsFields(s) {
  if ("masterName" in s && (!s.masterName || s.masterName.length > 40))
    return "Имя мастера — от 1 до 40 символов";
  if ("masterUsername" in s && !/^[A-Za-z0-9_]{0,32}$/.test(s.masterUsername))
    return "Логин Telegram — латиница, цифры и «_», до 32 символов";
  // Клиент открывает ссылку через openLink — только https, без javascript: и т. п.
  if ("mapUrl" in s && s.mapUrl && !/^https:\/\/\S+$/i.test(s.mapUrl))
    return "Ссылка на карту должна начинаться с https://";
  if ("slotStepMinutes" in s && !SLOT_STEPS.includes(s.slotStepMinutes))
    return `Шаг записи — одно из: ${SLOT_STEPS.join(", ")} минут`;
  if (
    "bookingDaysAhead" in s &&
    (!Number.isInteger(s.bookingDaysAhead) || s.bookingDaysAhead < 1 || s.bookingDaysAhead > 60)
  )
    return "Запись вперёд — от 1 до 60 дней";
  if (
    "minLeadMinutes" in s &&
    (!Number.isInteger(s.minLeadMinutes) || s.minLeadMinutes < 0 || s.minLeadMinutes > 10080)
  )
    return "Запись не позже чем — от 0 минут до 7 дней";
  return null;
}

/** Пишет только переданные поля: форма профиля не затирает правила записи и наоборот. */
export function saveSettings(patch) {
  const fields = normalizeSettingsFields(patch);
  const err = validateSettingsFields(fields);
  if (err) return Promise.resolve({ ok: false, error: err });
  const row = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [SETTINGS_COLUMNS[key], value])
  );
  if (Object.keys(row).length === 0) return Promise.resolve({ ok: true, error: null });
  return run(() => ownSettings(row), ["settings"]);
}

/* ─── Дни без записи ────────────────────────────────────────────── */

export function closeDay(day) {
  return run(() => supabase.from("days_off").insert({ day }), ["daysOff"]);
}

export function openDay(day) {
  return run(() => supabase.from("days_off").delete().eq("day", day), ["daysOff"]);
}

/* ─── Разово открытые выходные ──────────────────────────────────
   Нерабочий по графику день недели, открытый на одну дату (days_open):
   недельный график не меняется. Upsert — и открыть, и поправить часы.  */

export function openDayOnce(day, hours) {
  if (!hours?.from || !hours?.to || hours.from >= hours.to) {
    return Promise.resolve({ ok: false, error: "Конец дня должен быть позже начала" });
  }
  return run(
    () =>
      supabase
        .from("days_open")
        // salon_id не шлём — его ставит default (салон мастера).
        .upsert({ day, hours: { from: hours.from, to: hours.to } }, { onConflict: "salon_id,day" }),
    ["daysOpen"]
  );
}

export function closeDayOnce(day) {
  return run(() => supabase.from("days_open").delete().eq("day", day), ["daysOpen"]);
}

/* ─── Закрытые окошки ───────────────────────────────────────────── */

export function blockSlot(day, startMin) {
  return run(
    () => supabase.from("blocked_slots").insert({ day, start_min: startMin }),
    ["blockedSlots"]
  );
}

export function unblockSlot(day, startMin) {
  return run(
    () => supabase.from("blocked_slots").delete().eq("day", day).eq("start_min", startMin),
    ["blockedSlots"]
  );
}

/* ─── Записи ────────────────────────────────────────────────────── */

/** Подтверждение заявки — через approve_booking (schema.sql): она не даст
 *  подтвердить заявку поверх уже подтверждённой записи на то же время. */
export function approveBooking(id) {
  return run(() => supabase.rpc("approve_booking", { p_id: id }), BOOKINGS);
}

/** Удаление без восстановления. Уже удалённая запись — не ошибка:
 *  delete по несуществующему id просто ничего не находит. */
export function deleteBooking(id) {
  return run(() => supabase.from("bookings").delete().eq("id", id), BOOKINGS);
}

/** Оставил ли запись клиент со своим аккаунтом в мини-аппе — он узнает о
 *  решении сам, в «Мои записи» (src/bookings.js читает строки по user_id). */
export const clientSeesStatus = (booking) => !!booking?.user_id;

/** Записался из мини-аппа и есть Telegram-логин — кабинет сам откроет
 *  ему чат с сообщением об изменении (notifyClient в messages.js). */
export const canMessageClient = (booking) =>
  clientSeesStatus(booking) && !!String(booking?.client_username ?? "").trim();

/**
 * «Отклонить», «Отменить запись», корзина. Запись из мини-аппа не
 * удаляется, а получает status "cancelled": удалённую строку клиент не
 * отличил бы от заявки, которая не доехала, и видел бы «Ожидает
 * подтверждения» до самого дня записи. Записи без user_id (мастер
 * завела сама) спросить о статусе некому — их удаляем, как раньше.
 */
export function cancelBooking(booking) {
  if (!clientSeesStatus(booking)) return deleteBooking(booking.id);
  return run(
    () =>
      supabase
        .from("bookings")
        .update({ status: "cancelled", cancelled_by: "master", cancel_seen: true })
        .eq("id", booking.id),
    BOOKINGS
  );
}

/** «Понятно» на отмене клиента в «Заявках». */
export function ackCancellation(id) {
  return run(
    () => supabase.from("bookings").update({ cancel_seen: true }).eq("id", id),
    ["bookings"]
  );
}

/** Запись, которую заводит сам мастер: сразу подтверждённая, мимо «Заявок».
 *  clientId — существующий клиент; иначе newClient ({name, phone,
 *  telegram_username, channel}) создаёт нового в той же транзакции
 *  (см. create_master_booking в schema.sql). */
export async function createMasterBooking({ clientId, newClient, serviceId, day, startMin, comment }) {
  const nc = clientFields(newClient ?? {});
  return clientResult(
    await run(() =>
      supabase.rpc("create_master_booking", {
        p_client_id: clientId ?? null,
        p_new_name: nc.name,
        p_new_phone: nc.phone,
        p_new_telegram: nc.telegram_username,
        p_new_channel: nc.channel ?? "",
        p_service_id: serviceId,
        p_day: day,
        p_start_min: startMin,
        p_comment: String(comment ?? "").trim(),
      }),
      BOOKINGS
    )
  );
}

/** Правка записи из листа «Изменить»: клиент, услуга, время, комментарий —
 *  одной транзакцией, и запись становится подтверждённой. clientId null —
 *  завести нового клиента из client (см. update_master_booking). */
export async function updateMasterBooking(id, { clientId, client, serviceId, day, startMin, comment }) {
  const c = clientFields(client ?? {});
  return clientResult(
    await run(() =>
      supabase.rpc("update_master_booking", {
        p_id: id,
        p_client_id: clientId ?? null,
        p_client_name: c.name,
        p_client_phone: c.phone,
        p_client_telegram: c.telegram_username,
        // null — канал существующего клиента не трогаем.
        p_client_channel: c.channel ?? null,
        p_service_id: serviceId,
        p_day: day,
        p_start_min: startMin,
        p_comment: String(comment ?? "").trim(),
      }),
      BOOKINGS
    )
  );
}

/** Свободные старты под услугу на дату — считает сервер (free_slots).
 *  excludeId — переносимая запись: её собственное время свободно.
 *  Только чтение, поэтому без loadAdminData. */
export async function fetchFreeSlots(day, serviceId, excludeId = null) {
  if (!supabase) return { ok: false, error: NOT_CONFIGURED, slots: [] };
  try {
    const { data, error } = await supabase.rpc("free_slots", {
      p_day: day,
      p_service_id: serviceId,
      p_exclude_id: excludeId,
    });
    if (error) return { ...fail(error), slots: [] };
    return { ok: true, error: null, slots: (data ?? []).map((r) => r.start_min) };
  } catch (e) {
    return { ...fail(e), slots: [] };
  }
}

/** Сколько свободных стартов в каждом из days дней начиная с from — для
 *  шага «Выберите день». counts: Map "ГГГГ-ММ-ДД" → число. */
export async function fetchFreeSlotCounts(from, days, serviceId, excludeId = null) {
  if (!supabase) return { ok: false, error: NOT_CONFIGURED, counts: new Map() };
  try {
    const { data, error } = await supabase.rpc("free_slot_counts", {
      p_from: from,
      p_days: days,
      p_service_id: serviceId,
      p_exclude_id: excludeId,
    });
    if (error) return { ...fail(error), counts: new Map() };
    return {
      ok: true,
      error: null,
      counts: new Map((data ?? []).map((r) => [r.day, r.free_count])),
    };
  } catch (e) {
    return { ...fail(e), counts: new Map() };
  }
}

/* ─── Клиенты ───────────────────────────────────────────────────── */

/** Юзернейм без @ и пробелов — так он хранится и так сопоставляется
 *  с заявками в link_booking_client(). */
export function normalizeUsername(value) {
  return String(value ?? "").trim().replace(/^@+/, "");
}

/** Откуда клиент пишет мастеру — те же значения, что в clients_channel_chk. */
export const CHANNELS = [
  { id: "wa", label: "WhatsApp" },
  { id: "ig", label: "Instagram" },
  { id: "call", label: "Звонок" },
  { id: "live", label: "Лично" },
  { id: "tg", label: "Telegram" },
];

function clientFields({ name, telegram_username, phone, channel }) {
  const fields = {
    name: String(name ?? "").trim(),
    telegram_username: normalizeUsername(telegram_username),
    phone: String(phone ?? "").trim(),
  };
  // Не передан — не трогаем: правка клиента канал не показывает.
  if (channel !== undefined) fields.channel = CHANNELS.some((c) => c.id === channel) ? channel : "";
  return fields;
}

// Уникальный индекс clients_username_uq — два клиента с одним телеграмом.
function clientResult(res) {
  if (!res.ok && /clients_username_uq|duplicate key/.test(res.error)) {
    return { ...res, error: "Клиент с таким Telegram уже есть." };
  }
  return res;
}

export async function createClient(fields) {
  const res = await run(
    () => supabase.from("clients").insert(clientFields(fields)).select("id").single(),
    CLIENTS
  );
  return clientResult({ ...res, id: res.data?.id ?? null });
}

export async function updateClient(id, fields) {
  return clientResult(
    await run(
      () => supabase.from("clients").update(clientFields(fields)).eq("id", id),
      CLIENTS
    )
  );
}

/** Клиент со всеми его записями и комментариями — одной транзакцией
 *  (delete_client в schema.sql). Уже удалённый — ok с нулями.
 *  counts: { bookings, comments } — сколько удалилось. */
export async function deleteClient(id) {
  const res = await run(
    () => supabase.rpc("delete_client", { p_id: id }).single(),
    [...BOOKINGS, "comments"]
  );
  return {
    ...res,
    counts: {
      bookings: res.data?.bookings_deleted ?? 0,
      comments: res.data?.comments_deleted ?? 0,
    },
  };
}

export function addClientComment(clientId, body) {
  return run(
    () => supabase.from("client_comments").insert({ client_id: clientId, body: body.trim() }),
    ["comments"]
  );
}

export function deleteClientComment(id) {
  return run(() => supabase.from("client_comments").delete().eq("id", id), ["comments"]);
}
