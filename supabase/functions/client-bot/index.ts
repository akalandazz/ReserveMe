// Edge Function client-bot — вебхук бота клиента: /start, /help и кнопки
// «что умеет бот» (как записаться, перенос и отмена, напоминания, адрес,
// ваши данные). Тексты и кнопки — в _shared/client-bot.js (его же гоняет
// e2e/unit); здесь только приём апдейта и вызовы Bot API.
//
// Telegram шлёт POST с апдейтом и заголовком
// X-Telegram-Bot-Api-Secret-Token — тем secret_token, что передал
// scripts/setup-client-bot.mjs в setWebhook. Отвечаем всегда 200 (кроме
// чужого секрета): иначе Telegram будет повторять апдейт.
//
// Секреты (Dashboard → Edge Functions → Secrets, см. CLAUDE.md):
//   TELEGRAM_CLIENT_BOT_TOKEN  — тот же, что у telegram-auth и send-reminders;
//   CLIENT_BOT_WEBHOOK_SECRET  — общий с setWebhook, 1–256 символов
//                                A–Z a–z 0–9 _ -;
//   CLIENT_APP_URL             — необязательно: https-адрес мини-аппа, тогда
//                                в меню кнопка «Открыть запись»;
//   CLIENT_PRIVACY_URL         — необязательно: https-адрес privacy.html;
//   TELEGRAM_API_URL           — необязательно (подмена для тестов).
// SUPABASE_URL / SUPABASE_ANON_KEY Supabase подставляет сам: settings
// публичны, service-role ключ не нужен.
//
// Ничего не сохраняет. В логи — ни токена, ни chat id, ни текстов.
//
// Деплой — без проверки JWT (доступ закрыт секретом вебхука):
//   supabase functions deploy client-bot --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2";
import { botReplies } from "../_shared/client-bot.js";

const env = (name: string) => Deno.env.get(name)?.trim() ?? "";

const SUPABASE_URL = env("SUPABASE_URL");
const ANON_KEY = env("SUPABASE_ANON_KEY");
const BOT_TOKEN = env("TELEGRAM_CLIENT_BOT_TOKEN");
const WEBHOOK_SECRET = env("CLIENT_BOT_WEBHOOK_SECRET");
const APP_URL = env("CLIENT_APP_URL");
const PRIVACY_URL = env("CLIENT_PRIVACY_URL");
const API_URL = (env("TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/$/, "");

const SETTINGS_TIMEOUT_MS = 3_000;
const SEND_TIMEOUT_MS = 10_000;
const SALON_COLUMNS =
  "master_name, master_username, master_phone, address, landmark, transport, map_url, working_hours_text, reminder_hours";

const db = SUPABASE_URL && ANON_KEY
  ? createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null;

/** Сравнение секрета без раннего выхода: сравниваем хеши одинаковой длины. */
async function sameSecret(got: string, want: string) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all(
    [got, want].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))))
  );
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Строка settings или null — без неё бот ответит, только короче. */
async function loadSalon() {
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("settings")
      .select(SALON_COLUMNS)
      .eq("id", 1)
      .abortSignal(AbortSignal.timeout(SETTINGS_TIMEOUT_MS))
      .maybeSingle();
    if (error) console.error("client-bot: settings:", error.code ?? "error");
    return data ?? null;
  } catch {
    console.error("client-bot: settings: timeout");
    return null;
  }
}

async function call(method: string, body: unknown) {
  try {
    const res = await fetch(`${API_URL}/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.body?.cancel();
    // 400 «message is not modified» — повторное нажатие той же кнопки, не ошибка.
    if (!res.ok && res.status !== 400) console.error(`client-bot: ${method}: ${res.status}`);
  } catch {
    console.error(`client-bot: ${method}: network`);
  }
}

const ok = () => new Response("ok", { status: 200, headers: { "cache-control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!BOT_TOKEN || !WEBHOOK_SECRET) {
    console.error("client-bot: not configured");
    return new Response("not_configured", { status: 500 });
  }
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!(await sameSecret(got, WEBHOOK_SECRET))) return new Response("unauthorized", { status: 401 });

  let update: unknown;
  try {
    update = await req.json();
  } catch {
    return ok();
  }

  // Апдейт без ответа (группа, сервисное сообщение) — базу не трогаем.
  if (!botReplies(update).length) return ok();

  const salon = await loadSalon();
  for (const { method, body } of botReplies(update, { salon, appUrl: APP_URL, privacyUrl: PRIVACY_URL })) {
    await call(method, body);
  }
  return ok();
});
