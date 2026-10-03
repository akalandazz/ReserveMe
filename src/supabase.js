// Клиент Supabase и сессия — вход через Telegram.
//
// Данные салона читают все — анонимно, публичным anon-ключом. Пишут и
// читают личное только вошедшие: границей безопасности служит RLS в базе
// (см. supabase/schema.sql), а не секретность ключа — ключ уезжает
// в собранный бандл и виден любому.
//
// Вход: подписанная Telegram строка initData уходит в Edge Function
// telegram-auth (supabase/functions/telegram-auth), та проверяет подпись
// токеном бота и отдаёт обычную сессию Supabase аккаунта, привязанного к
// Telegram user id. Паролей и e-mail нет. Один Telegram-аккаунт — один
// пользователь на всех устройствах; у каждого устройства своя сессия.
//
// Сессия живёт ТОЛЬКО в памяти (persistSession: false): ни токен, ни
// refresh-токен не попадают в localStorage. Каждый запуск мини-аппа входит
// заново — Telegram и так отдаёт свежий initData при каждом открытии.
//
// Роль ('user' | 'master') решает только база (profiles, is_master());
// снапшот несёт её лишь затем, чтобы кабинет не показывал клиенту пустой
// экран. Этим модулем пользуются оба приложения.

import { useSyncExternalStore } from "react";
import { createClient } from "@supabase/supabase-js";
import { POLICY_VERSION } from "./legal.js";
import { initData } from "./telegram.js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Переменные окружения заданы. Иначе приложение живёт на кэше и ругается. */
export const SUPABASE_READY = Boolean(URL && KEY);

export const supabase = SUPABASE_READY
  ? createClient(URL, KEY, {
      auth: {
        // В памяти, не в localStorage: долгоживущий refresh-токен на
        // устройстве не нужен — initData приходит при каждом запуске.
        persistSession: false,
        autoRefreshToken: true,
        // ⚠️ ОБЯЗАТЕЛЬНО false. Telegram открывает мини-апп с хешем
        // #tgWebAppData=…, а supabase-js по умолчанию разбирает хеш
        // как OAuth-колбэк и переписывает history.
        detectSessionInUrl: false,
      },
      // Мимо HTTP-кэша браузера и вебвью Telegram: цена, выходной или
      // занятое окошко из кэша хуже, чем лишний запрос.
      global: {
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
      },
    })
  : null;

// Прежние версии хранили сессию (с refresh-токеном) в localStorage под
// этими ключами. Теперь сессия только в памяти — остатки убираем.
for (const key of ["vs_sb_client_v1", "vs_sb_auth_v1"]) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // приватный режим — и хранить там нечего
  }
}

export const NOT_CONFIGURED =
  "Supabase не настроен: нет VITE_SUPABASE_URL или VITE_SUPABASE_ANON_KEY.";

/* ─── Внешнее хранилище сессии ───────────────────────────────────
   Идиома та же, что у темы в src/theme.js: снапшот — объект на уровне
   модуля, useSyncExternalStore получает ОДНУ И ТУ ЖЕ ссылку, пока
   ничего не менялось. Новый объект на каждый вызов getSnapshot —
   бесконечный цикл рендера.

   status:
     "unknown"     — идёт вход;
     "signed"      — вошёл;
     "no-telegram" — открыто не как мини-апп (обычный браузер): входить нечем;
     "consent"     — сервер ждёт согласия на обработку ПДн (152-ФЗ) с
                     текущей редакцией политики: экран согласия → acceptConsent();
     "guest"       — вышел сам или сессию не удалось продлить;
     "error"       — вход не удался, error — текст для экрана.
   role: null — ещё не прочитана, "user" | "master", "error" — прочитать
   не удалось (кабинет предлагает повторить, а не пускает «на всякий случай»).
   name — имя из профиля (проверенный initData), для «Вы вошли как …».  */

const signedOut = (status, error = null) => ({ status, error, name: null, role: null });

let snapshot = signedOut("unknown");
let started = false;
let userId = null;
// Растёт на каждой смене сессии: ответ про роль прежнего пользователя
// не должен лечь в снапшот нового.
let roleSeq = 0;
// Растёт на каждой попытке входа: поздний ответ старой не перебьёт новую.
let signInSeq = 0;
const listeners = new Set();

function publish(next) {
  snapshot = next;
  listeners.forEach((fn) => fn());
}

/* ─── Роль: profiles ─────────────────────────────────────────────
   Строку заводит Edge Function при входе — приложение её только читает
   (писать в profiles RLS не даёт никому, кроме service role).          */

async function loadRole(id, seq) {
  let role = "error";
  let name = null;
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("role,first_name,last_name,telegram_username")
      .eq("id", id)
      .limit(1);
    if (!error) {
      const p = data?.[0];
      role = p?.role ?? "user";
      name =
        [p?.first_name, p?.last_name].filter(Boolean).join(" ") ||
        (p?.telegram_username ? `@${p.telegram_username}` : null);
    }
  } catch {
    // role остаётся "error"
  }
  if (seq === roleSeq) publish({ ...snapshot, role, name });
}

function applySession(session) {
  const id = session?.user?.id ?? null;
  if (!id) {
    userId = null;
    roleSeq++;
    // Сессия пропала у вошедшего (не удалось продлить) — на экран входа.
    // До входа (INITIAL_SESSION без сессии) экран не трогаем: вход идёт.
    if (snapshot.status === "signed") publish(signedOut("guest"));
    return;
  }
  // Тот же пользователь (обновился токен) — роль уже известна.
  if (id === userId && snapshot.status === "signed") return;
  userId = id;
  const seq = ++roleSeq;
  publish({ status: "signed", error: null, name: null, role: null });
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

export function useSession() {
  return useSyncExternalStore(subscribeAuth, authSnapshot, authSnapshot);
}

/* ─── Вход через Telegram ─────────────────────────────────────── */

const SIGN_IN_TIMEOUT_MS = 15_000;

// Коды из тела ответа telegram-auth (401, 500 not_configured) и "not_deployed" —
// 404 шлюза, когда функции нет в проекте. Последние два «Повторить» не лечит.
const NOT_SET_UP = "Вход не настроен на сервере. Сообщите мастеру.";
const SIGN_IN_ERRORS = {
  expired: "Данные входа устарели. Закройте приложение и откройте его заново из Telegram.",
  invalid_init_data: "Telegram не подтвердил вход. Откройте приложение заново из Telegram.",
  not_configured: NOT_SET_UP,
  not_deployed: NOT_SET_UP,
};
const STALE_POLICY =
  "Политика обработки данных обновилась. Закройте приложение и откройте его заново из Telegram.";

/** Код ошибки из тела ответа функции (FunctionsHttpError), если есть. */
async function functionError(error) {
  if (error?.context?.status === 404) return "not_deployed";
  try {
    const body = await error?.context?.json?.();
    return body?.error ?? null;
  } catch {
    return null;
  }
}

/**
 * Войти по initData текущего запуска. Вызывают initAuth() при старте и
 * экраны входа («Повторить», «Войти снова»). Ничего не бросает.
 * Аргументов не берёт — экраны отдают её прямо в onClick.
 */
export function signInWithTelegram() {
  return signIn(false);
}

/**
 * «Согласен» на экране согласия: тот же вход, но с редакцией политики,
 * которую клиент только что видел, — telegram-auth запишет согласие до
 * того, как заведёт аккаунт.
 */
export function acceptConsent() {
  return signIn(true);
}

async function signIn(consent) {
  if (!supabase) {
    publish(signedOut("error", NOT_CONFIGURED));
    return;
  }
  const data = initData();
  if (!data) {
    publish(signedOut("no-telegram"));
    return;
  }
  const mine = ++signInSeq;
  publish(signedOut("unknown"));

  const body = consent ? { initData: data, consent: POLICY_VERSION } : { initData: data };
  const res = await withTimeout(
    supabase.functions.invoke("telegram-auth", { body }),
    SIGN_IN_TIMEOUT_MS
  );
  if (mine !== signInSeq) return;
  if (!res) {
    publish(signedOut("error", "Нет связи с сервером"));
    return;
  }
  if (res.error || !res.data?.access_token || !res.data?.refresh_token) {
    const code = res.error ? await functionError(res.error) : null;
    if (mine !== signInSeq) return;
    // Согласие с ЭТОЙ редакцией сервер уже получил бы — значит, у сервера
    // новее, а бандл старый: снова показывать тот же текст бессмысленно.
    if (code === "consent_required") {
      publish(consent ? signedOut("error", STALE_POLICY) : signedOut("consent"));
      return;
    }
    publish(signedOut("error", SIGN_IN_ERRORS[code] ?? "Не удалось войти. Попробуйте ещё раз."));
    return;
  }

  const { error } = await supabase.auth.setSession({
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token,
  });
  if (mine !== signInSeq) return;
  // Успех сам придёт в onAuthStateChange → applySession.
  if (error) publish(signedOut("error", "Не удалось войти. Попробуйте ещё раз."));
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
    publish(signedOut("error", NOT_CONFIGURED));
    return;
  }

  // SIGNED_IN после setSession, TOKEN_REFRESHED, SIGNED_OUT после выхода
  // или неудачного продления.
  supabase.auth.onAuthStateChange((_event, session) => {
    applySession(session);
  });
  signInWithTelegram();
}

/**
 * Выход с ЭТОГО устройства: сервер отзывает refresh-токен этой сессии
 * (scope "local"), сессии на других устройствах живут дальше. Уже
 * выданный access-токен действует до своего истечения (до часа) — так
 * устроен JWT; в памяти его больше нет.
 */
export async function signOut() {
  if (!supabase) return;
  signInSeq++;
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // не смогли сказать серверу — локальную сессию клиент всё равно чистит
  }
  userId = null;
  roleSeq++;
  publish(signedOut("guest"));
}

/** id вошедшего пользователя или null — для src/bookings.js. */
export function currentUserId() {
  return snapshot.status === "signed" ? userId : null;
}

/** Резолвится null, если promise не успел за ms или упал. */
export function withTimeout(promise, ms) {
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
