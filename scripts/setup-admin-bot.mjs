// Кнопки тестовой среды в боте кабинета — запускается вручную, один раз и после
// смены секрета Vercel или адреса превью. Только в ОДНОМ чате (PREVIEW_CHAT_ID —
// ваш числовой Telegram id): закреплённое сообщение с двумя web_app-кнопками
// «Кабинет (preview)» и «Клиент (preview)» (sendMessage, pinChatMessage).
// Кнопка меню не трогается — она и дальше открывает кабинет из прода.
// Превью закрыто Vercel Authentication, поэтому в URL идёт секрет
// Protection Bypass for Automation (Project → Settings → Deployment Protection).
// Превью работает на той же базе Supabase, что и прод: тестовые записи — настоящие.
//
// Токен и секрет — только из переменных окружения, в репозиторий не пишутся:
//   TELEGRAM_CABINET_BOT_TOKEN=… PREVIEW_CHAT_ID=… VERCEL_BYPASS_SECRET=… \
//   node scripts/setup-admin-bot.mjs
// PREVIEW_URL — по умолчанию алиас ветки dev. Если кнопка меню этого чата была
// переставлена на превью (старая версия скрипта), вернуть её к проду:
//   node scripts/setup-admin-bot.mjs --reset

const env = (name) => process.env[name]?.trim() ?? "";

const TOKEN = env("TELEGRAM_CABINET_BOT_TOKEN");
const CHAT_ID = env("PREVIEW_CHAT_ID");
const BYPASS = env("VERCEL_BYPASS_SECRET");
const BASE = (env("PREVIEW_URL") || "https://telegram-miniapp-git-dev-amurikokalandia-8335.vercel.app")
  .replace(/\/+$/, "");
const RESET = process.argv.includes("--reset");

if (!TOKEN || !/^-?\d+$/.test(CHAT_ID) || (!RESET && !BYPASS)) {
  console.error(
    "Нужны TELEGRAM_CABINET_BOT_TOKEN, PREVIEW_CHAT_ID (число) и VERCEL_BYPASS_SECRET."
  );
  process.exit(1);
}
if (!/^https:\/\//.test(BASE)) {
  console.error("PREVIEW_URL должен начинаться с https://.");
  process.exit(1);
}

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
  console.log(`✓ ${method}`);
  return json.result;
}

const chat_id = Number(CHAT_ID);

if (RESET) {
  await call("setChatMenuButton", { chat_id, menu_button: { type: "default" } });
  process.exit(0);
}

// samesitenone — чтобы cookie обхода работала и во фрейме Telegram Web/Desktop.
const bypass = new URLSearchParams({
  "x-vercel-protection-bypass": BYPASS,
  "x-vercel-set-bypass-cookie": "samesitenone",
});
const cabinetUrl = `${BASE}/admin.html?${bypass}`;
const clientUrl = `${BASE}/?${bypass}`;

const msg = await call("sendMessage", {
  chat_id,
  text: "Тестовая среда (ветка dev)",
  reply_markup: {
    inline_keyboard: [[
      { text: "Кабинет (preview)", web_app: { url: cabinetUrl } },
      { text: "Клиент (preview)", web_app: { url: clientUrl } },
    ]],
  },
});
await call("pinChatMessage", { chat_id, message_id: msg.message_id, disable_notification: true });
