// POST /api/invite — «Пригласить в приложение» в кабинете (бывшая функция
// client-invite; src/admin/api.js → sendClientInvite). { client_id } с JWT
// мастера.
//
//   1. create_client_invite(client_id) — от имени мастера: права, салон и
//      карточка проверяются там же, где всегда (schema.sql); прежний код
//      карточки перестаёт работать. JWT здесь проверяет сама база —
//      функция api развёрнута без проверки JWT платформой (см. index.ts);
//   2. если клиент с юзернеймом карточки уже в приложении и бот может ему
//      писать (bot_invite_recipient) — бот клиента салона сам шлёт
//      приглашение с кнопками «Принять» / «Отклонить» (inviteOffer из
//      _shared/client-bot.js, ответы ловит /api/bot);
//   3. иначе — sent: false, и кабинет открывает мастеру чат с клиентом со
//      ссылкой t.me/<бот>?start=c_<код>: бот не может написать первым.
//
// Ответ: 200 { code, sent } | 4xx { error } — текст отказа базы, по-русски.
// Telegram 403 (бот остановлен) — отметка bot_unreachable_at, как у
// напоминаний, и sent: false. В логи — ни токена, ни chat id, ни кода.

import { createClient } from "npm:@supabase/supabase-js@2";
import { inviteOffer } from "../_shared/client-bot.js";
import { ANON_KEY, API_URL, CORS, NO_SESSION, SUPABASE_URL, admin, clientBotToken, json } from "../_shared/server.ts";

const SEND_TIMEOUT_MS = 10_000;

/** Бот пишет приглашение сам. → true, если Telegram его принял. */
async function sendByBot(code: string) {
  const { data: rec, error } = await admin.rpc("bot_invite_recipient", { p_code: code });
  if (error) console.error("invite: bot_invite_recipient:", error.code ?? "error");
  const to = rec?.[0];
  if (!to) return false;

  const { data: view } = await admin.rpc("bot_client_invite", {
    p_salon: to.salon_id,
    p_code: code,
    p_telegram_id: to.telegram_id,
  });
  const { data: salon } = await admin
    .from("salons")
    .select("id, salon_bots(kind, token)")
    .eq("id", to.salon_id)
    .maybeSingle();
  const token = salon ? clientBotToken(salon) : "";
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
    else if (!res.ok) console.error(`invite: sendMessage: ${res.status}`);
    return res.ok;
  } catch {
    console.error("invite: sendMessage: network");
    return false;
  }
}

export async function handleInvite(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer \S+$/.test(authorization)) return json(401, { error: "Войдите заново" });

  let clientId: unknown;
  try {
    clientId = (await req.json())?.client_id;
  } catch {
    return json(400, { error: "bad_request" });
  }
  if (!Number.isSafeInteger(clientId)) return json(400, { error: "bad_request" });

  // От имени вызывающего — все проверки (JWT, мастер, салон) в create_client_invite.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    auth: NO_SESSION,
    global: { headers: { authorization } },
  });
  const { data: code, error } = await asCaller.rpc("create_client_invite", { p_client_id: clientId });
  if (error || typeof code !== "string") {
    // Просроченный или поддельный JWT PostgREST отвергает сам (PGRST3xx).
    const status = error?.code === "42501" ? 403 : /^PGRST3/.test(error?.code ?? "") ? 401 : 400;
    return json(status, {
      error: error?.code === "P0001" ? error.message : "Не удалось создать приглашение",
    });
  }

  return json(200, { code, sent: await sendByBot(code) });
}
