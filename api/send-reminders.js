// Vercel-функция send-reminders — бот клиента напоминает о записи.
//
// GET (так зовёт Vercel Cron) или POST, с заголовком
// `Authorization: Bearer <CRON_SECRET>` → claim_due_reminders()
// (supabase/schema.sql: подтверждённые записи клиентов мини-аппа, до
// начала которых осталось не больше settings.reminder_hours) → sendMessage
// от бота клиента на profiles.telegram_id → { claimed, sent, unreachable,
// retry, drop }. Что писать и как разбирать ответ Telegram — в
// supabase/functions/_shared/reminders.js (его же гоняют e2e/unit и
// e2e/integration).
//
// Расписание — vercel.json → crons, раз в 10 минут. Запись помечается
// reminded_at ДО отправки, так что наложившиеся запуски не напомнят
// дважды; временная ошибка Telegram возвращает её в очередь.
//
// Переменные окружения Vercel (Production; без префикса VITE_ — иначе
// они уехали бы в бандл):
//   SUPABASE_URL              — адрес проекта;
//   SUPABASE_SERVICE_ROLE_KEY — service role: claim_due_reminders и соседи
//                               закрыты от anon и authenticated;
//   TELEGRAM_CLIENT_BOT_TOKEN — тот же, что у telegram-auth: пишет бот,
//                               в котором клиент открывает мини-апп;
//   CRON_SECRET               — длинная случайная строка; Vercel Cron сам
//                               шлёт её в Authorization;
//   CLIENT_APP_URL            — необязательно: https-адрес мини-аппа, тогда
//                               под сообщением кнопка «Мои записи»;
//   TELEGRAM_API_URL          — необязательно, по умолчанию
//                               https://api.telegram.org (подмена для тестов).
//
// В логи не пишется ни токен, ни telegram_id, ни текст — только счётчики
// и коды ошибок.

import { createHash, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runReminders } from "../supabase/functions/_shared/reminders.js";

/** Сколько записей за запуск — с запасом до maxDuration (vercel.json). */
const BATCH = 50;
const SEND_TIMEOUT_MS = 10_000;
/** Telegram — до ~30 сообщений в секунду на бота. */
const PAUSE_MS = 50;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Сравнение секрета без раннего выхода: сравниваем хеши одинаковой длины. */
function sameSecret(got, want) {
  const digest = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(got), digest(want));
}

/** Обработчик с окружением параметром — e2e/integration зовёт его напрямую. */
export function createHandler(env) {
  const get = (name) => env[name]?.trim() ?? "";
  const SUPABASE_URL = get("SUPABASE_URL");
  const SERVICE_KEY = get("SUPABASE_SERVICE_ROLE_KEY");
  const BOT_TOKEN = get("TELEGRAM_CLIENT_BOT_TOKEN");
  const CRON_SECRET = get("CRON_SECRET");
  const APP_URL = get("CLIENT_APP_URL");
  const API_URL = (get("TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/$/, "");

  async function send(body) {
    const res = await fetch(`${API_URL}/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, PAUSE_MS));
    return res.status;
  }

  return async (req) => {
    if (req.method !== "GET" && req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }
    if (!SUPABASE_URL || !SERVICE_KEY || !BOT_TOKEN || !CRON_SECRET) {
      console.error("send-reminders: not configured");
      return json(500, { error: "not_configured" });
    }
    if (!sameSecret(req.headers.get("authorization") ?? "", `Bearer ${CRON_SECRET}`)) {
      return json(401, { error: "unauthorized" });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const rpc = async (name, args) => {
      const { data, error } = await admin.rpc(name, args);
      if (error) throw new Error(`${name}: ${error.code ?? "error"}`);
      return data;
    };

    let counts;
    try {
      counts = await runReminders({ rpc, send, now: new Date(), appUrl: APP_URL, batch: BATCH });
    } catch (e) {
      // Сюда доходит только сбой claim — deliverReminders наружу не бросает.
      console.error("send-reminders:", e.message);
      return json(500, { error: "server_error" });
    }
    if (counts.claimed) console.log("send-reminders:", JSON.stringify(counts));
    return json(200, counts);
  };
}

const handler = createHandler(process.env);
export const GET = handler;
export const POST = handler;
