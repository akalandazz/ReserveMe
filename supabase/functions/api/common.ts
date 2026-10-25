// Общее для маршрутов Edge Function api (index.ts): окружение, клиент
// service role, CORS, ответы, сравнение секретов и бот клиента салона.
//
// Секреты (Dashboard → Edge Functions → Secrets — никогда не через
// `supabase secrets set` из репозитория, см. CLAUDE.md):
//   TELEGRAM_CLIENT_BOT_TOKEN  — необязательно: бот клиента салона 1, пока
//                                его токен не перенесён в salon_bots;
//   TELEGRAM_CABINET_BOT_TOKEN — то же для бота кабинета салона 1 (auth);
//   CLIENT_BOT_WEBHOOK_SECRET  — secret_token вебхука бота клиента салона 1,
//                                пока его нет в salon_bots (bot);
//   REMINDERS_CRON_SECRET      — общий с cron-задачей (reminders);
//   CLIENT_APP_URL             — необязательно: https-адрес мини-аппа, тогда
//                                у сообщений бота кнопка в приложение;
//   CLIENT_PRIVACY_URL         — необязательно: https-адрес privacy.html (bot);
//   INITDATA_MAX_AGE_SECONDS   — необязательно, по умолчанию 3600 (auth);
//   AUTH_EMAIL_DOMAIN          — необязательно, по умолчанию telegram.local (auth);
//   TELEGRAM_API_URL           — необязательно (подмена Bot API для тестов).
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY Supabase
// подставляет сам.

import { createClient } from "npm:@supabase/supabase-js@2";

export const env = (name: string) => Deno.env.get(name)?.trim() ?? "";

export const SUPABASE_URL = env("SUPABASE_URL");
export const ANON_KEY = env("SUPABASE_ANON_KEY");
export const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
export const API_URL = (env("TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/$/, "");

// Боты салона 1 из секретов — до переноса их токенов в salon_bots.
export const DEFAULT_SALON = 1;
export const ENV_CLIENT_BOT_TOKEN = env("TELEGRAM_CLIENT_BOT_TOKEN");
export const SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;

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

/** Токен бота клиента из строки салона с salon_bots(kind, token, …), или "". */
export function clientBotToken(salon: { id: number; salon_bots?: { kind: string; token: string }[] | null }) {
  const bot = (salon.salon_bots ?? []).find((b) => b.kind === "client");
  return bot?.token || (salon.id === DEFAULT_SALON ? ENV_CLIENT_BOT_TOKEN : "");
}

const APP_URL = env("CLIENT_APP_URL");

/** Адрес мини-аппа этого салона (кнопка в сообщениях бота) или "". */
export function appUrlFor(slug: string) {
  if (!/^https:\/\//.test(APP_URL)) return "";
  const url = new URL(APP_URL);
  url.searchParams.set("salon", slug);
  return url.toString();
}
