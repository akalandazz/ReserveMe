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
// Салоны: у каждого салона свой бот клиента и свой вебхук —
// …/client-bot?salon=<slug> (scripts/setup-client-bot.mjs). Токен бота и
// secret_token вебхука — из salon_bots этого салона (kind = 'client'),
// настройки — его строка settings. Без ?salon — салон 1, и для него пока
// работают секреты ниже.
//
// Секреты (Dashboard → Edge Functions → Secrets, см. CLAUDE.md):
//   TELEGRAM_CLIENT_BOT_TOKEN  — необязательно: бот клиента салона 1, пока
//                                его токен не перенесён в salon_bots;
//   CLIENT_BOT_WEBHOOK_SECRET  — то же для secret_token его вебхука,
//                                1–256 символов A–Z a–z 0–9 _ -;
//   CLIENT_APP_URL             — необязательно: https-адрес мини-аппа, тогда
//                                в меню кнопка «Открыть запись» (с ?salon=);
//   CLIENT_PRIVACY_URL         — необязательно: https-адрес privacy.html;
//   TELEGRAM_API_URL           — необязательно (подмена для тестов).
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам:
// salon_bots и settings анониму не видны.
//
// Ничего не сохраняет. В логи — ни токена, ни chat id, ни текстов.
//
// Деплой — без проверки JWT (доступ закрыт секретом вебхука):
//   supabase functions deploy client-bot --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2";
import { botReplies } from "../_shared/client-bot.js";

const env = (name: string) => Deno.env.get(name)?.trim() ?? "";

const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
// Бот салона 1 из секретов — до переноса в salon_bots.
const DEFAULT_SALON = 1;
const ENV_TOKEN = env("TELEGRAM_CLIENT_BOT_TOKEN");
const ENV_WEBHOOK_SECRET = env("CLIENT_BOT_WEBHOOK_SECRET");
const SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;
const APP_URL = env("CLIENT_APP_URL");
const PRIVACY_URL = env("CLIENT_PRIVACY_URL");
const API_URL = (env("TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/$/, "");

const SETTINGS_TIMEOUT_MS = 3_000;
const SEND_TIMEOUT_MS = 10_000;
const SALON_COLUMNS =
  "master_name, master_username, master_phone, address, landmark, transport, map_url, working_hours_text, reminder_hours";

const db = SUPABASE_URL && SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null;

type Bot = { salonId: number; slug: string; token: string; secret: string };

/** Бот клиента салона по slug из адреса вебхука (пусто — салон 1); null — нет такого. */
async function loadBot(slug: string): Promise<Bot | null> {
  if (!db || (slug && !SLUG.test(slug))) return null;
  const q = db.from("salons").select("id, slug, salon_bots(kind, token, webhook_secret)");
  const { data, error } = await (slug ? q.eq("slug", slug) : q.eq("id", DEFAULT_SALON))
    .abortSignal(AbortSignal.timeout(SETTINGS_TIMEOUT_MS))
    .maybeSingle();
  if (error) console.error("client-bot: salons:", error.code ?? "error");
  if (!data) return null;
  const bot = (data.salon_bots ?? []).find((b: { kind: string }) => b.kind === "client");
  const fallback = data.id === DEFAULT_SALON;
  const token = bot?.token || (fallback ? ENV_TOKEN : "");
  const secret = bot?.webhook_secret || (fallback ? ENV_WEBHOOK_SECRET : "");
  return token && secret ? { salonId: data.id, slug: data.slug, token, secret } : null;
}

/** Кнопка «Открыть запись» — мини-апп этого салона. */
function appUrlFor(slug: string) {
  if (!/^https:\/\//.test(APP_URL)) return "";
  const url = new URL(APP_URL);
  url.searchParams.set("salon", slug);
  return url.toString();
}

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

/** Строка settings салона или null — без неё бот ответит, только короче. */
async function loadSalon(salonId: number) {
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("settings")
      .select(SALON_COLUMNS)
      .eq("salon_id", salonId)
      .abortSignal(AbortSignal.timeout(SETTINGS_TIMEOUT_MS))
      .maybeSingle();
    if (error) console.error("client-bot: settings:", error.code ?? "error");
    return data ?? null;
  } catch {
    console.error("client-bot: settings: timeout");
    return null;
  }
}

async function call(token: string, method: string, body: unknown) {
  try {
    const res = await fetch(`${API_URL}/bot${token}/${method}`, {
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
  let bot: Bot | null = null;
  try {
    bot = await loadBot(new URL(req.url).searchParams.get("salon") ?? "");
  } catch {
    console.error("client-bot: salons: timeout");
  }
  if (!bot) {
    console.error("client-bot: not configured");
    return new Response("not_configured", { status: 500 });
  }
  // Секрет — именно этого салона: апдейт чужого бота сюда не пройдёт.
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!(await sameSecret(got, bot.secret))) return new Response("unauthorized", { status: 401 });

  let update: unknown;
  try {
    update = await req.json();
  } catch {
    return ok();
  }

  // Апдейт без ответа (группа, сервисное сообщение) — базу не трогаем.
  if (!botReplies(update).length) return ok();

  const salon = await loadSalon(bot.salonId);
  const appUrl = appUrlFor(bot.slug);
  for (const { method, body } of botReplies(update, { salon, appUrl, privacyUrl: PRIVACY_URL })) {
    await call(bot.token, method, body);
  }
  return ok();
});
