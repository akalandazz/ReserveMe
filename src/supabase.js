// Клиент Supabase и сессия мастера.
//
// Данные салона читают все — анонимно, публичным anon-ключом. Пишет
// только вошедший мастер: границей безопасности служит RLS в базе
// (см. supabase/schema.sql), а не секретность ключа — ключ уезжает
// в собранный бандл и виден любому.
//
// Заявка клиента (src/storage.js) сохраняется локально И вставляется
// сюда, в таблицу bookings, — это нужно кабинету мастера (admin.html),
// у которого нет доступа к CloudStorage клиента. RLS пускает вошедшего
// клиента только на INSERT новой своей заявки; читает и правит записи
// (в том числе видит имя и комментарий клиента) только мастер — иначе
// любой зарегистрировавшийся увидел бы личные данные всех клиентов.
//
// Этим модулем пользуются оба приложения, и в обоих есть вход по e-mail
// и паролю: клиент регистрируется сам (signUp) и получает роль 'user',
// мастер — единственный аккаунт с ролью 'master' (таблица profiles, см.
// is_master() в schema.sql). Роль решает только база; снапшот сессии
// несёт её лишь затем, чтобы кабинет не показывал клиенту пустой экран.

import { useSyncExternalStore } from "react";
import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Переменные окружения заданы. Иначе приложение живёт на кэше и ругается. */
export const SUPABASE_READY = Boolean(URL && KEY);

// Сессии кабинета и мини-аппа — под разными ключами: на одном домене
// localStorage общий, и мастер, вошедшая в кабинет, иначе оказалась бы
// «клиентом» в мини-аппе (и наоборот). Ключ кабинета прежний — мастер
// не вылетает после обновления.
const IS_CABINET = /\/admin(\.html)?$/.test(globalThis.location?.pathname ?? "");
export const AUTH_STORAGE_KEY = IS_CABINET ? "vs_sb_auth_v1" : "vs_sb_client_v1";

export const supabase = SUPABASE_READY
  ? createClient(URL, KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // ⚠️ ОБЯЗАТЕЛЬНО false. Telegram открывает мини-апп с хешем
        // #tgWebAppData=…, а supabase-js по умолчанию разбирает хеш
        // как OAuth-колбэк и переписывает history.
        detectSessionInUrl: false,
        storageKey: AUTH_STORAGE_KEY,
      },
      // Мимо HTTP-кэша браузера и вебвью Telegram: цена, выходной или
      // занятое окошко из кэша хуже, чем лишний запрос.
      global: {
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
      },
    })
  : null;

export const NOT_CONFIGURED =
  "Supabase не настроен: нет VITE_SUPABASE_URL или VITE_SUPABASE_ANON_KEY.";

/* ─── Внешнее хранилище сессии ───────────────────────────────────
   Идиома та же, что у темы в src/theme.js: снапшот — объект на уровне
   модуля, useSyncExternalStore получает ОДНУ И ТУ ЖЕ ссылку, пока
   ничего не менялось. Новый объект на каждый вызов getSnapshot —
   бесконечный цикл рендера.                                        */

// role: null — ещё не прочитана, "user" | "master", "error" — прочитать
// не удалось (кабинет предлагает повторить, а не пускает «на всякий случай»).
const GUEST = { status: "guest", email: null, role: null };

let snapshot = { status: "unknown", email: null, role: null };
let started = false;
let userId = null;
// Растёт на каждой смене сессии: ответ про роль прежнего пользователя
// не должен лечь в снапшот нового.
let roleSeq = 0;
const listeners = new Set();

function publish(next) {
  snapshot = next;
  listeners.forEach((fn) => fn());
}

/* ─── Роль: profiles ─────────────────────────────────────────────
   Триггера на auth.users нет (так решено) — строку profiles заводит
   само приложение, при КАЖДОМ появлении сессии: после регистрации с
   автоподтверждением, после входа, после восстановления сессии при
   запуске. Регистрация с подтверждением по почте сессии не даёт, и
   строка появится при первом входе. ignoreDuplicates — ON CONFLICT DO
   NOTHING: роль мастера этим не перезаписать. Провал безопасен: без
   строки is_master() в базе всё равно false.                        */

async function loadRole(id, seq) {
  let role = "error";
  try {
    await supabase
      .from("profiles")
      .upsert({ id, role: "user" }, { onConflict: "id", ignoreDuplicates: true });
    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", id)
      .limit(1);
    if (!error) role = data?.[0]?.role ?? "user";
  } catch {
    // role остаётся "error"
  }
  if (seq === roleSeq) publish({ ...snapshot, role });
}

function applySession(session) {
  const id = session?.user?.id ?? null;
  if (!id) {
    userId = null;
    roleSeq++;
    publish(GUEST);
    return;
  }
  const email = session.user.email ?? null;
  // Тот же пользователь (обновился токен) — роль уже известна.
  if (id === userId && snapshot.status === "signed") {
    if (email !== snapshot.email) publish({ ...snapshot, email });
    return;
  }
  userId = id;
  const seq = ++roleSeq;
  publish({ status: "signed", email, role: null });
  // Не внутри колбэка onAuthStateChange: запрос к базе оттуда ждёт
  // блокировку auth, которую держит сам колбэк, — взаимная блокировка.
  setTimeout(() => loadRole(id, seq), 0);
}

/** Кабинет: «Повторить», когда роль прочитать не удалось. */
export function retryRole() {
  if (!supabase || !userId) return;
  const seq = ++roleSeq;
  publish({ ...snapshot, role: null });
  loadRole(userId, seq);
}

export function authSnapshot() {
  return snapshot;
}

export function subscribeAuth(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Вызывать один раз при старте приложения.
 * Флаг started — защита от двойного вызова эффекта под React.StrictMode:
 * onAuthStateChange не дедуплицирует подписки.
 */
export function initAuth() {
  if (started) return;
  started = true;

  if (!supabase) {
    publish(GUEST);
    return;
  }

  supabase.auth.getSession().then(({ data }) => {
    applySession(data?.session ?? null);
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    applySession(session);
  });
}

export function useSession() {
  return useSyncExternalStore(subscribeAuth, authSnapshot, authSnapshot);
}

/* ─── Вход, регистрация и выход ─────────────────────────────────── */

// Тексты Supabase английские — показываем свои.
const AUTH_ERRORS = {
  invalid_credentials: "Неверный e-mail или пароль",
  email_not_confirmed:
    "E-mail ещё не подтверждён — откройте письмо со ссылкой и войдите снова.",
  over_request_rate_limit: "Слишком много попыток. Подождите минуту.",
  // Встроенная почта Supabase шлёт всего несколько писем в ЧАС на весь
  // проект — «подождите минуту» тут неправда.
  over_email_send_rate_limit:
    "Сервер временно не может отправить письмо. Попробуйте позже.",
  validation_failed: "Заполните e-mail и пароль",
  user_already_exists: "Этот e-mail уже зарегистрирован — войдите",
  email_exists: "Этот e-mail уже зарегистрирован — войдите",
  weak_password: "Слишком простой пароль — минимум 6 символов",
  email_address_invalid: "Проверьте e-mail — адрес выглядит неверным",
  signup_disabled: "Регистрация сейчас закрыта",
};

function authError(error, fallback = "Не удалось войти. Проверьте данные и соединение.") {
  // Сеть упала — auth-js не бросает, а возвращает эту ошибку без code.
  if (error?.name === "AuthRetryableFetchError") return "Нет связи с сервером";
  return AUTH_ERRORS[error?.code] ?? fallback;
}

/** { ok, error } — экрану ничего не бросаем. */
export async function signIn(email, password) {
  if (!supabase) return { ok: false, error: NOT_CONFIGURED };
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) return { ok: false, error: authError(error) };
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: "Нет связи с сервером" };
  }
}

/**
 * Регистрация клиента. Роль 'user' ставит не она, а applySession() →
 * loadRole(), как только появится сессия.
 * @returns {Promise<{ok:boolean, needsConfirm?:boolean, error:string|null}>}
 *   needsConfirm — в панели Supabase включено подтверждение e-mail:
 *   сессии нет, пока клиент не откроет письмо.
 */
export async function signUp(email, password) {
  if (!supabase) return { ok: false, error: NOT_CONFIGURED };
  try {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
    });
    if (error) {
      return { ok: false, error: authError(error, "Не удалось зарегистрироваться. Проверьте соединение.") };
    }
    if (data?.session) return { ok: true, needsConfirm: false, error: null };
    // При включённом подтверждении Supabase не выдаёт, что адрес занят, —
    // отдаёт пользователя без identities.
    if (data?.user && data.user.identities?.length === 0) {
      return { ok: false, error: AUTH_ERRORS.user_already_exists };
    }
    return { ok: true, needsConfirm: true, error: null };
  } catch {
    return { ok: false, error: "Нет связи с сервером" };
  }
}

export async function signOut() {
  if (!supabase) return;
  try {
    await supabase.auth.signOut();
  } catch {
    // не смогли сказать серверу — локальную сессию клиент всё равно чистит
  }
  userId = null;
  roleSeq++;
  publish(GUEST);
}

/* ─── Заявка клиента → bookings ──────────────────────────────────
   Вызывается из BookingScreen.submit() ДО sendToMaster (см. CLAUDE.md
   про openTelegramLink). Best-effort и с коротким таймаутом — как
   promisify() в src/storage.js: недоступная база не должна задержать
   клиента, а провал не должен ни отменить запись (она уже сохранена
   локально), ни помешать отправке сообщения мастеру.                */

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/**
 * row — снэйк-кейс колонок bookings, без status/source (их проверяет
 *   политика bookings_insert_client).
 * @returns {Promise<boolean|null>} true — строка точно в базе (в том числе
 *   уже была: дубль client_token — это повтор того же insert); false —
 *   сервер отказал; null — неизвестно (таймаут, нет сети). Вызывающий
 *   кладёт это в запись как sv, и syncBookings() (src/sync.js) досылает
 *   заявку, чья судьба неизвестна.
 */
export async function submitBooking(row) {
  if (!supabase) return null;
  const res = await withTimeout(
    supabase.from("bookings").insert({ ...row, status: "new", source: "client" }),
    3000
  );
  if (!res) return null;
  if (!res.error) return true;
  // 23505 — уникальный индекс bookings_client_token_uq: строка уже лежит.
  return res.error.code === "23505";
}

/* ─── Статус своей заявки ────────────────────────────────────────
   Мастер подтверждает заявку в кабинете, а у клиента запись лежит в
   CloudStorage — без этого запроса «Мои записи» вечно показывали бы
   «Ожидает подтверждения».

   Идём через RPC booking_status (см. supabase/schema.sql), а не в
   таблицу: анониму select по bookings не давали и не даём — функция
   отдаёт только статус и только тех строк, чей client_token клиент
   уже знает, потому что сам его и придумал.                        */

/**
 * @param {string[]} tokens — client_token'ы своих записей.
 * @returns {Promise<Map<string,{status:string,cancelledBy:string,day?:string,
 *   start?:number,duration?:number,price?:number,serviceId?:string|null}>|null>}
 *   токен → статус, кто отменил ("client" | "master" | "") и текущие
 *   день/время/услуга строки — мастер могла перенести запись.
 *   null — «спросить не удалось» (нет сети, таймаут, Supabase не настроен);
 *   пустая Map — «спросили, таких строк нет». Вызывающий в обоих случаях
 *   обязан оставить прежний статус: пропавшая строка неотличима от
 *   заявки, чей best-effort insert не доехал.
 */
export async function fetchBookingStatuses(tokens) {
  if (!supabase || !tokens.length) return null;
  const res = await withTimeout(
    supabase.rpc("booking_status", { p_tokens: tokens }),
    3000
  );
  if (!res || res.error || !Array.isArray(res.data)) return null;
  return new Map(
    res.data.map((r) => [
      r.client_token,
      {
        status: r.status,
        cancelledBy: r.cancelled_by ?? "",
        day: r.day,
        start: r.start_min,
        duration: r.duration,
        price: r.price,
        serviceId: r.service_id,
      },
    ])
  );
}

/* ─── Отмена своей записи ────────────────────────────────────────
   RPC cancel_own_booking (schema.sql): строка остаётся со статусом
   "cancelled", мастер видит её в «Заявках» → «Отмены», окно
   освобождается для других клиентов. Best-effort, как submitBooking:
   вызывается ДО sendToMaster, провал не мешает отмене на устройстве. */

/** @returns {Promise<boolean>} true — сервер отметил отмену. */
export async function cancelOwnBooking(token) {
  if (!supabase || !token) return false;
  const res = await withTimeout(
    supabase.rpc("cancel_own_booking", { p_token: token }),
    3000
  );
  return !!res && !res.error && res.data === true;
}
