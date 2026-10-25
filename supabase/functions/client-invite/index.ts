// Edge Function client-invite — «Пригласить в приложение» в кабинете
// (src/admin/api.js → sendClientInvite). POST { client_id } с JWT мастера.
//
//   1. create_client_invite(client_id) — от имени мастера: права, салон и
//      карточка проверяются там же, где всегда (schema.sql); прежний код
//      карточки перестаёт работать;
//   2. если клиент с юзернеймом карточки уже в приложении и бот может ему
//      писать (bot_invite_recipient) — бот клиента салона сам шлёт
//      приглашение с кнопками «Принять» / «Отклонить» (inviteOffer из
//      _shared/client-bot.js, ответы ловит client-bot);
//   3. иначе — sent: false, и кабинет открывает мастеру чат с клиентом со
//      ссылкой t.me/<бот>?start=c_<код>: бот не может написать первым.
//
// Ответ: 200 { code, sent } | 4xx { error } — текст отказа базы, по-русски.
// Telegram 403 (бот остановлен) — отметка bot_unreachable_at, как у
// напоминаний, и sent: false.
//
// Секреты: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
// подставляет Supabase; TELEGRAM_CLIENT_BOT_TOKEN — бот салона 1, пока его
// токен не в salon_bots; TELEGRAM_API_URL — подмена для тестов.
// В логи — ни токена, ни chat id, ни кода.
//
// Деплой — с проверкой JWT (зовёт только вошедший мастер):
//   supabase functions deploy client-invite

import { createClient } from "npm:@supabase/supabase-js@2";
import { inviteOffer } from "../_shared/client-bot.js";

const env = (name: string) => Deno.env.get(name)?.trim() ?? "";

const SUPABASE_URL = env("SUPABASE_URL");
const ANON_KEY = env("SUPABASE_ANON_KEY");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
// Бот клиента салона 1 из секретов — до переноса токена в salon_bots.
const DEFAULT_SALON = 1;
const ENV_TOKEN = env("TELEGRAM_CLIENT_BOT_TOKEN");
const API_URL = (env("TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/$/, "");
const SEND_TIMEOUT_MS = 10_000;

// Кабинет зовёт функцию из браузера (supabase.functions.invoke).
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: NO_SESSION });

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Токен бота клиента салона или "". */
async function clientBotToken(salonId: number) {
  const { data } = await admin
    .from("salon_bots")
    .select("token")
    .eq("salon_id", salonId)
    .eq("kind", "client")
    .maybeSingle();
  return data?.token || (salonId === DEFAULT_SALON ? ENV_TOKEN : "");
}

/** Бот пишет приглашение сам. → true, если Telegram его принял. */
async function sendByBot(code: string) {
  const { data: rec, error } = await admin.rpc("bot_invite_recipient", { p_code: code });
  if (error) console.error("client-invite: bot_invite_recipient:", error.code ?? "error");
  const to = rec?.[0];
  if (!to) return false;

  const { data: view } = await admin.rpc("bot_client_invite", {
    p_salon: to.salon_id,
    p_code: code,
    p_telegram_id: to.telegram_id,
  });
  const token = await clientBotToken(to.salon_id);
  if (view?.[0]?.status !== "open" || !token) return false;

  try {
    const res = await fetch(`${API_URL}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: to.telegram_id, ...inviteOffer(view[0], code) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (res.status === 403) await admin.rpc("mark_bot_unreachable", { p_telegram_id: to.telegram_id });
    else if (!res.ok) console.error(`client-invite: sendMessage: ${res.status}`);
    return res.ok;
  } catch {
    console.error("client-invite: sendMessage: network");
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  let clientId: unknown;
  try {
    clientId = (await req.json())?.client_id;
  } catch {
    return json(400, { error: "bad_request" });
  }
  if (!Number.isSafeInteger(clientId)) return json(400, { error: "bad_request" });

  // От имени мастера — все проверки в create_client_invite.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    auth: NO_SESSION,
    global: { headers: { authorization: req.headers.get("authorization") ?? "" } },
  });
  const { data: code, error } = await asCaller.rpc("create_client_invite", { p_client_id: clientId });
  if (error || typeof code !== "string") {
    return json(error?.code === "42501" ? 403 : 400, {
      error: error?.code === "P0001" ? error.message : "Не удалось создать приглашение",
    });
  }

  return json(200, { code, sent: await sendByBot(code) });
});
