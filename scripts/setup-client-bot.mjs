// Настройка бота клиента в Telegram — запускается вручную, один раз и после
// каждой правки описания или команд в supabase/functions/_shared/client-bot.js:
//   • описание в пустом чате и строка профиля (setMyDescription,
//     setMyShortDescription);
//   • меню команд /start, /book, /contacts, /privacy (setMyCommands);
//   • вебхук на Edge Function client-bot с секретом (setWebhook).
//
// Токен и секрет — только из переменных окружения, в репозиторий не пишутся:
//   TELEGRAM_CLIENT_BOT_TOKEN=… CLIENT_BOT_WEBHOOK_SECRET=… \
//   CLIENT_BOT_WEBHOOK_URL=https://<проект>.supabase.co/functions/v1/client-bot \
//   node scripts/setup-client-bot.mjs
// CLIENT_BOT_WEBHOOK_SECRET — тот же, что в секретах функции client-bot.
//
// Бот другого салона (не салона 1): CLIENT_BOT_SALON=<slug> — вебхук получит
// ?salon=<slug>, а токен и секрет должны совпадать с его строкой
// public.salon_bots (kind = 'client', token / webhook_secret), см.
// supabase/add-salon.sql.

import {
  BOT_COMMANDS,
  BOT_DESCRIPTION,
  BOT_SHORT_DESCRIPTION,
} from "../supabase/functions/_shared/client-bot.js";

const env = (name) => process.env[name]?.trim() ?? "";

const TOKEN = env("TELEGRAM_CLIENT_BOT_TOKEN");
const SECRET = env("CLIENT_BOT_WEBHOOK_SECRET");
const SALON = env("CLIENT_BOT_SALON");
const BASE_URL = env("CLIENT_BOT_WEBHOOK_URL");

if (SALON && !/^[a-z0-9][a-z0-9-]{1,31}$/.test(SALON)) {
  console.error("CLIENT_BOT_SALON: slug салона из public.salons (a–z 0–9 -).");
  process.exit(1);
}
if (!TOKEN || !SECRET || !/^https:\/\//.test(BASE_URL)) {
  console.error(
    "Нужны TELEGRAM_CLIENT_BOT_TOKEN, CLIENT_BOT_WEBHOOK_SECRET и CLIENT_BOT_WEBHOOK_URL (https)."
  );
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(SECRET)) {
  console.error("CLIENT_BOT_WEBHOOK_SECRET: 1–256 символов A–Z a–z 0–9 _ - (так требует Telegram).");
  process.exit(1);
}

const webhook = new URL(BASE_URL);
if (SALON) webhook.searchParams.set("salon", SALON);
const WEBHOOK_URL = webhook.toString();

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
  console.log(`✓ ${method}`);
}

// Без language_code — для всех языков интерфейса: клиенты говорят по-русски.
await call("setMyDescription", { description: BOT_DESCRIPTION });
await call("setMyShortDescription", { short_description: BOT_SHORT_DESCRIPTION });
await call("setMyCommands", { commands: BOT_COMMANDS });
await call("setWebhook", {
  url: WEBHOOK_URL,
  secret_token: SECRET,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
