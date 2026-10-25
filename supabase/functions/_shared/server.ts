// Общее для Edge Functions api и send-reminders: окружение, клиент
// service role, CORS, ответы, сравнение секретов и бот клиента салона.
// Только Deno (Deno.env, npm:-импорт) — в отличие от остальных модулей
// _shared, которые исполняет и Node (e2e/unit, scripts/).
//
// Секреты (Dashboard → Edge Functions → Secrets — никогда не через
// `supabase secrets set` из репозитория, см. CLAUDE.md):
//   SALON_BOTS                 — боты всех салонов: JSON по slug с токенами
//                                ботов клиента и кабинета и secret_token
//                                вебхука (формат — _shared/salon-bots.js);
//   REMINDERS_CRON_SECRET      — общий с cron-задачей (send-reminders);
//   CLIENT_APP_URL             — необязательно: https-адрес мини-аппа, тогда
//                                у сообщений бота кнопка в приложение;
//   CLIENT_PRIVACY_URL         — необязательно: https-адрес privacy.html (bot);
//   INITDATA_MAX_AGE_SECONDS   — необязательно, по умолчанию 3600 (auth);
//   AUTH_EMAIL_DOMAIN          — необязательно, по умолчанию telegram.local (auth);
//   TELEGRAM_API_URL           — необязательно (подмена Bot API для тестов).
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY Supabase
// подставляет сам.

import { createClient } from "npm:@supabase/supabase-js@2";
import { parseSalonBots } from "./salon-bots.js";

export { SLUG, signInTokens } from "./salon-bots.js";

export const env = (name: string) => Deno.env.get(name)?.trim() ?? "";

export const SUPABASE_URL = env("SUPABASE_URL");
export const ANON_KEY = env("SUPABASE_ANON_KEY");
export const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
export const API_URL = (env("TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/$/, "");

// Без ?salon в адресе — салон 1 (до салонов был только он).
export const DEFAULT_SALON = 1;

type SalonBot = { client: string; cabinet: string; webhookSecret: string };

// Разбирается один раз на экземпляр функции. Кривая запись выпадает одна
// (её салон не войдёт и не получит апдейтов); в лог — только тексты
// ошибок, в них нет токенов.
const parsed = parseSalonBots(env("SALON_BOTS"));
for (const e of parsed.errors) console.error("SALON_BOTS:", e);
const SALON_BOTS: Map<string, SalonBot> = parsed.bots;

/** Боты салона из секрета SALON_BOTS или undefined — их там нет. */
export function salonBots(slug: string): SalonBot | undefined {
  return SALON_BOTS.get(slug);
}

export const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
/** Клиент service role — RLS не действует, салон каждый маршрут фильтрует сам. */
export const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: NO_SESSION });

// Ответы с токенами (auth) идут не по cookie, а приглашение (invite)
// проверяет JWT в базе — CORS открыт, как у остальных эндпоинтов Supabase.
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

export function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Сравнение секрета без раннего выхода: сравниваем хеши одинаковой длины. */
export async function sameSecret(got: string, want: string) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all(
    [got, want].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))))
  );
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Токен бота клиента салона по slug, или "". */
export function clientBotToken(slug: string) {
  return salonBots(slug)?.client ?? "";
}

const APP_URL = env("CLIENT_APP_URL");

/** Адрес мини-аппа этого салона (кнопка в сообщениях бота) или "". */
export function appUrlFor(slug: string) {
  if (!/^https:\/\//.test(APP_URL)) return "";
  const url = new URL(APP_URL);
  url.searchParams.set("salon", slug);
  return url.toString();
}
