// Клиент Supabase и сессия мастера.
//
// Данные салона читают все — анонимно, публичным anon-ключом. Пишет
// только вошедший мастер: границей безопасности служит RLS в базе
// (см. supabase/schema.sql), а не секретность ключа — ключ уезжает
// в собранный бандл и виден любому.
//
// Заявка клиента (src/storage.js) сохраняется локально И вставляется
// сюда, в таблицу bookings, — это нужно кабинету мастера (admin.html),
// у которого нет доступа к CloudStorage клиента. RLS пускает анонима
// только на INSERT новой своей заявки; читает и правит записи (в том
// числе видит имя и комментарий клиента) только вошедший мастер —
// иначе анонимный ключ отдал бы личные данные всех клиентов кому угодно.
//
// Этим модулем пользуются оба приложения: клиент — анонимно, только на
// чтение и на вставку своей заявки; кабинет мастера — через signIn/signOut,
// вход возможен только там.

import { useSyncExternalStore } from "react";
import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Переменные окружения заданы. Иначе приложение живёт на кэше и ругается. */
export const SUPABASE_READY = Boolean(URL && KEY);

export const supabase = SUPABASE_READY
  ? createClient(URL, KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // ⚠️ ОБЯЗАТЕЛЬНО false. Telegram открывает мини-апп с хешем
        // #tgWebAppData=…, а supabase-js по умолчанию разбирает хеш
        // как OAuth-колбэк и переписывает history.
        detectSessionInUrl: false,
        storageKey: "vs_sb_auth_v1",
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

let snapshot = { status: "unknown", email: null };
let started = false;
const listeners = new Set();

function publish(next) {
  snapshot = next;
  listeners.forEach((fn) => fn());
}

function fromSession(session) {
  return session
    ? { status: "signed", email: session.user?.email ?? null }
    : { status: "guest", email: null };
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
    publish({ status: "guest", email: null });
    return;
  }

  supabase.auth.getSession().then(({ data }) => {
    publish(fromSession(data?.session ?? null));
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    publish(fromSession(session));
  });
}

export function useSession() {
  return useSyncExternalStore(subscribeAuth, authSnapshot, authSnapshot);
}

/* ─── Вход и выход ──────────────────────────────────────────────── */

// Тексты Supabase английские — показываем свои.
const AUTH_ERRORS = {
  invalid_credentials: "Неверный e-mail или пароль",
  email_not_confirmed:
    "E-mail не подтверждён. Включите «Auto Confirm User» в панели Supabase.",
  over_request_rate_limit: "Слишком много попыток. Подождите минуту.",
  validation_failed: "Заполните e-mail и пароль",
};

function authError(error) {
  return (
    AUTH_ERRORS[error?.code] ??
    "Не удалось войти. Проверьте данные и соединение."
  );
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

export async function signOut() {
  if (!supabase) return;
  try {
    await supabase.auth.signOut();
  } catch {
    // не смогли сказать серверу — локальную сессию клиент всё равно чистит
  }
  publish({ status: "guest", email: null });
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

/** row — снэйк-кейс колонок bookings, без status/source (их ставит anon-политика). */
export async function submitBooking(row) {
  if (!supabase) return;
  await withTimeout(
    supabase.from("bookings").insert({ ...row, status: "new", source: "client" }),
    3000
  );
}
