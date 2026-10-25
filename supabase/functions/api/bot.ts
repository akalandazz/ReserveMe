// POST /api/bot?salon=<slug> — вебхук бота клиента (бывшая функция
// client-bot): /start, /help и кнопки «что умеет бот» (как записаться,
// перенос и отмена, напоминания, адрес, ваши данные), а также приглашение
// мастера ("/start c_<код>" и кнопки «Принять» / «Отклонить»). Тексты и
// кнопки — в _shared/client-bot.js (его же гоняет e2e/unit); здесь только
// приём апдейта, база и вызовы Bot API.
//
// Telegram шлёт POST с апдейтом и заголовком
// X-Telegram-Bot-Api-Secret-Token — тем secret_token, что передал
// setWebhook (scripts/setup-client-bot.mjs, npm run add-master). Отвечаем
// всегда 200 (кроме чужого секрета): иначе Telegram будет повторять апдейт.
//
// Салоны: у каждого салона свой бот клиента и свой вебхук —
// …/api/bot?salon=<slug>. Токен бота и secret_token вебхука — из
// salon_bots этого салона (kind = 'client'), настройки — его строка
// settings. Без ?salon — салон 1, и для него пока работают секреты
// TELEGRAM_CLIENT_BOT_TOKEN / CLIENT_BOT_WEBHOOK_SECRET (_shared/server.ts).
//
// Приглашение — через bot_client_invite / bot_answer_client_invite
// (schema.sql): база запоминает, кто ответил. Остальное бот не сохраняет.
// В логи — ни токена, ни chat id, ни текстов, ни кодов.

import {
  botReplies,
  inviteAnswerReplies,
  inviteStartReplies,
  inviteUpdate,
} from "../_shared/client-bot.js";
import {
  API_URL,
  DEFAULT_SALON,
  SERVICE_KEY,
  SLUG,
  admin,
  appUrlFor,
  clientBotToken,
  env,
  sameSecret,
} from "../_shared/server.ts";

const ENV_WEBHOOK_SECRET = env("CLIENT_BOT_WEBHOOK_SECRET");
const PRIVACY_URL = env("CLIENT_PRIVACY_URL");

const SETTINGS_TIMEOUT_MS = 3_000;
const SEND_TIMEOUT_MS = 10_000;
const SALON_COLUMNS =
  "master_name, master_username, master_phone, address, landmark, transport, map_url, working_hours_text, reminder_hours";

type Bot = { salonId: number; slug: string; token: string; secret: string };

/** Бот клиента салона по slug из адреса вебхука (пусто — салон 1); null — нет такого. */
async function loadBot(slug: string): Promise<Bot | null> {
  if (!SERVICE_KEY || (slug && !SLUG.test(slug))) return null;
  const q = admin.from("salons").select("id, slug, salon_bots(kind, token, webhook_secret)");
  const { data, error } = await (slug ? q.eq("slug", slug) : q.eq("id", DEFAULT_SALON))
    .abortSignal(AbortSignal.timeout(SETTINGS_TIMEOUT_MS))
    .maybeSingle();
  if (error) console.error("bot: salons:", error.code ?? "error");
  if (!data) return null;
  const bot = (data.salon_bots ?? []).find((b: { kind: string }) => b.kind === "client");
  const token = clientBotToken(data);
  const secret = bot?.webhook_secret || (data.id === DEFAULT_SALON ? ENV_WEBHOOK_SECRET : "");
  return token && secret ? { salonId: data.id, slug: data.slug, token, secret } : null;
}

/** Строка settings салона или null — без неё бот ответит, только короче. */
async function loadSalon(salonId: number) {
  try {
    const { data, error } = await admin
      .from("settings")
      .select(SALON_COLUMNS)
      .eq("salon_id", salonId)
      .abortSignal(AbortSignal.timeout(SETTINGS_TIMEOUT_MS))
      .maybeSingle();
    if (error) console.error("bot: settings:", error.code ?? "error");
    return data ?? null;
  } catch {
    console.error("bot: settings: timeout");
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
    if (!res.ok && res.status !== 400) console.error(`bot: ${method}: ${res.status}`);
  } catch {
    console.error(`bot: ${method}: network`);
  }
}

const ok = () => new Response("ok", { status: 200, headers: { "cache-control": "no-store" } });

type InviteIntent = { kind: "start" | "answer"; code: string; telegramId: number; accept?: boolean };

/** Строка bot_client_invite для "/start c_<код>" или null — база не ответила. */
async function inviteView(salonId: number, intent: InviteIntent) {
  const { data, error } = await admin.rpc("bot_client_invite", {
    p_salon: salonId,
    p_code: intent.code,
    p_telegram_id: intent.telegramId,
  });
  if (error) console.error("bot: bot_client_invite:", error.code ?? "error");
  return error ? null : (data?.[0] ?? null);
}

/** Ответ bot_answer_client_invite ('linked', 'pending', …) или null — база не ответила. */
async function answerInvite(salonId: number, intent: InviteIntent) {
  const { data, error } = await admin.rpc("bot_answer_client_invite", {
    p_salon: salonId,
    p_code: intent.code,
    p_telegram_id: intent.telegramId,
    p_accept: intent.accept === true,
  });
  if (error) console.error("bot: bot_answer_client_invite:", error.code ?? "error");
  return error || typeof data !== "string" ? null : data;
}

export async function handleBot(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  let bot: Bot | null = null;
  try {
    bot = await loadBot(new URL(req.url).searchParams.get("salon") ?? "");
  } catch {
    console.error("bot: salons: timeout");
  }
  if (!bot) {
    console.error("bot: not configured");
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

  const appUrl = appUrlFor(bot.slug);

  // Приглашение мастера — раньше меню: "/start c_<код>" — тоже /start.
  const intent = inviteUpdate(update);
  if (intent) {
    const calls =
      intent.kind === "start"
        ? inviteStartReplies(intent, await inviteView(bot.salonId, intent), { appUrl })
        : inviteAnswerReplies(intent, await answerInvite(bot.salonId, intent), { appUrl });
    for (const { method, body } of calls) await call(bot.token, method, body);
    return ok();
  }

  // Апдейт без ответа (группа, сервисное сообщение) — базу не трогаем.
  if (!botReplies(update).length) return ok();

  const salon = await loadSalon(bot.salonId);
  for (const { method, body } of botReplies(update, { salon, appUrl, privacyUrl: PRIVACY_URL })) {
    await call(bot.token, method, body);
  }
  return ok();
}
