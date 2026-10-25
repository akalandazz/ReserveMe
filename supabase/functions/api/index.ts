// Edge Function api — весь сервер приложения в одной функции. Маршрут —
// последняя часть адреса …/functions/v1/api/<маршрут>:
//
//   POST /api/auth       — вход через Telegram (auth.ts): мини-апп и кабинет
//                          до появления сессии;
//   POST /api/reminders  — напоминания о записях (reminders.ts): pg_cron,
//                          заголовок x-cron-secret;
//   POST /api/bot        — вебхук бота клиента (bot.ts): Telegram, заголовок
//                          X-Telegram-Bot-Api-Secret-Token, ?salon=<slug>;
//   POST /api/invite     — «Пригласить в приложение» (invite.ts): кабинет,
//                          JWT мастера.
//
// Одна функция — один деплой, один набор секретов (common.ts) и один
// прогретый процесс на все маршруты. Проверка JWT платформой у функции
// одна на все маршруты, и её нет (вход, cron и Telegram приходят без
// JWT): каждый маршрут закрыт сам — подписью initData, секретом cron,
// секретом вебхука салона или JWT, который проверяет база (invite).
// Новый маршрут обязан делать то же.
//
// Деплой (локально то же задаёт supabase/config.toml):
//   supabase functions deploy api --no-verify-jwt

import { handleAuth } from "./auth.ts";
import { handleBot } from "./bot.ts";
import { CORS, json } from "./common.ts";
import { handleInvite } from "./invite.ts";
import { handleReminders } from "./reminders.ts";

const ROUTES: Record<string, (req: Request) => Promise<Response>> = {
  auth: handleAuth,
  reminders: handleReminders,
  bot: handleBot,
  invite: handleInvite,
};

Deno.serve(async (req) => {
  const route = /\/api\/([a-z]+)\/?$/.exec(new URL(req.url).pathname)?.[1] ?? "";
  const handle = Object.hasOwn(ROUTES, route) ? ROUTES[route] : null;
  if (!handle) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    return json(404, { error: "not_found" });
  }
  try {
    return await handle(req);
  } catch {
    // Маршруты ловят свои ошибки сами; сюда — только непредвиденное.
    console.error(`api: ${route}: unexpected error`);
    return json(500, { error: "server_error" });
  }
});
