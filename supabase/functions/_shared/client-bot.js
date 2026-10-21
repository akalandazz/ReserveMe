// Бот клиента: ответы на /start, /help и кнопки «что умеет бот».
//
// Обычный ESM без зависимостей, как reminders.js: его исполняют Edge
// Function client-bot (Deno, вебхук), scripts/setup-client-bot.mjs (Node:
// команды и описание бота в Telegram) и юнит-тест e2e/unit. Сети здесь
// нет — botReplies() только решает, какие вызовы Bot API сделать.
//
// salon — строка settings (master_name, master_username, master_phone,
// address, landmark, transport, map_url, working_hours_text,
// reminder_hours) или null, если базу прочитать не удалось: тогда разделы
// обходятся без неё.
//
// Без parse_mode — ничего не экранируем, адрес и имя уходят как есть.

/** Описание в пустом чате, до «Запустить» (setMyDescription, до 512 символов). */
export const BOT_DESCRIPTION = [
  "Онлайн-запись к мастеру — без переписки и ожидания ответа.",
  "",
  "• услуги, цены и свободное время на ближайшие дни;",
  "• заявка на удобное время — мастер её подтвердит;",
  "• «Мои записи»: статус, перенос и отмена;",
  "• напоминание о записи сообщением от этого бота.",
  "",
  "Нажмите «Запустить» — бот расскажет подробнее.",
].join("\n");

/** Строка в профиле бота и в поиске (setMyShortDescription, до 120 символов). */
export const BOT_SHORT_DESCRIPTION =
  "Запись к мастеру: услуги и цены, свободное время, перенос, отмена и напоминания.";

/** Меню команд (setMyCommands). */
export const BOT_COMMANDS = [
  { command: "start", description: "Что умеет бот" },
  { command: "book", description: "Как записаться" },
  { command: "contacts", description: "Адрес и контакты" },
  { command: "privacy", description: "Ваши данные" },
];

const isHttps = (url) => /^https:\/\//.test(url ?? "");
const clean = (s) => (typeof s === "string" ? s.trim() : "");
const btn = (text, data) => ({ text, callback_data: data });
const BACK = btn("← Назад", "menu");

/** 1 час, 2 часа, 5 часов. */
function hours(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} час`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} часа`;
  return `${n} часов`;
}

function master(salon) {
  return clean(salon?.master_name) || "мастер";
}

function appButton(appUrl, text = "Открыть запись") {
  return isHttps(appUrl) ? [{ text, web_app: { url: appUrl } }] : null;
}

function menuText(salon) {
  const name = clean(salon?.master_name);
  return [
    "Здравствуйте! 👋",
    "",
    name
      ? `Это бот записи к мастеру — ${name}. Здесь можно записаться, перенести или отменить запись и получить напоминание о ней.`
      : "Это бот записи к мастеру. Здесь можно записаться, перенести или отменить запись и получить напоминание о ней.",
    "",
    "Сама запись — в приложении: кнопка «Открыть запись» ниже или кнопка меню слева от поля ввода. Остальные кнопки расскажут, как всё устроено.",
  ].join("\n");
}

function menuKeyboard(appUrl) {
  const rows = [
    [btn("📅 Как записаться", "i:book"), btn("🔁 Перенос и отмена", "i:move")],
    [btn("🔔 Напоминания", "i:remind"), btn("📍 Адрес и контакты", "i:contacts")],
    [btn("🔒 Ваши данные", "i:privacy")],
  ];
  const app = appButton(appUrl);
  if (app) rows.unshift(app);
  return { inline_keyboard: rows };
}

const SECTIONS = {
  book: (salon) => [
    "📅 Как записаться",
    "",
    "1. Откройте приложение — кнопка «Открыть запись».",
    "2. Выберите услугу, день и свободное время.",
    "3. Отправьте заявку: приложение откроет чат с мастером и подготовит сообщение — его остаётся только отправить.",
    "",
    `Заявка — ещё не запись: время ваше, когда ${master(salon)} её подтвердит. ` +
      "Статус видно в приложении, в «Мои записи». Если запись подтвердят, перенесут или отменят, приложение покажет это при следующем открытии.",
  ],
  move: (salon) => [
    "🔁 Перенос и отмена",
    "",
    "Откройте приложение → «Мои записи» и выберите запись:",
    `• «Перенести» — выберите другой день и время. Перенесённая запись снова ждёт подтверждения (${master(salon)}).`,
    "• «Отменить» — время освободится для других.",
    "",
    "После этого приложение предложит написать мастеру — так о переменах узнают быстрее.",
  ],
  remind: (salon) => {
    const n = Number(salon?.reminder_hours);
    if (salon && n === 0) {
      return [
        "🔔 Напоминания",
        "",
        "Сейчас напоминания о записи выключены. Статус записи можно посмотреть в приложении, в «Мои записи».",
      ];
    }
    const when = n > 0 ? `примерно за ${hours(n)} до начала` : "незадолго до начала";
    return [
      "🔔 Напоминания",
      "",
      `Бот напомнит о подтверждённой записи ${when} — сообщением в этот чат, с адресом и временем.`,
      "",
      "О заявках, которые ещё ждут подтверждения, бот не напоминает.",
      "",
      "Выключить или снова включить напоминания — переключатель «Напоминать о записи» в «Мои записи». " +
        "Если вы остановили бота, напоминания не придут, пока вы снова его не запустите.",
    ];
  },
  contacts: (salon) => {
    const lines = ["📍 Адрес и контакты", ""];
    const name = clean(salon?.master_name);
    const username = clean(salon?.master_username);
    const fields = [
      name && `💅 ${name}`,
      clean(salon?.address) && `📍 ${clean(salon.address)}`,
      clean(salon?.landmark),
      clean(salon?.transport) && `🚌 ${clean(salon.transport)}`,
      isHttps(clean(salon?.map_url)) && `🗺 ${clean(salon.map_url)}`,
      clean(salon?.working_hours_text) && `🕐 ${clean(salon.working_hours_text)}`,
      clean(salon?.master_phone) && `📞 ${clean(salon.master_phone)}`,
      username && `✉️ @${username}`,
    ].filter(Boolean);
    if (fields.length) lines.push(...fields);
    else lines.push("Адрес и контакты мастера — в приложении, в разделе «Важная информация».");
    return lines;
  },
  privacy: (_salon, { privacyUrl }) => [
    "🔒 Ваши данные",
    "",
    "Вход в приложение — через ваш аккаунт Telegram: пароль, телефон и e-mail не нужны. Сохраняются Telegram ID, имя и username, а также ваши записи — их видите вы и мастер.",
    "",
    "Сообщения, которые вы пишете этому боту, не сохраняются и никем не читаются.",
    "",
    isHttps(privacyUrl)
      ? `Подробно — в политике обработки персональных данных: ${privacyUrl}`
      : "Подробно — в политике обработки персональных данных: приложение → «Важная информация».",
  ],
};

/** Текст и кнопки раздела, null — такого раздела нет. */
export function sectionMessage(key, { salon = null, appUrl = "", privacyUrl = "" } = {}) {
  const build = Object.hasOwn(SECTIONS, key) ? SECTIONS[key] : null;
  if (!build) return null;
  const rows = [];
  if (key === "book" || key === "move") {
    const app = appButton(appUrl, key === "book" ? "Открыть запись" : "Мои записи");
    if (app) rows.push(app);
  }
  rows.push([BACK]);
  return {
    text: build(salon, { privacyUrl }).join("\n"),
    reply_markup: { inline_keyboard: rows },
    disable_web_page_preview: true,
  };
}

/** Главное меню: приветствие и кнопки разделов. */
export function menuMessage({ salon = null, appUrl = "" } = {}) {
  return { text: menuText(salon), reply_markup: menuKeyboard(appUrl) };
}

/** Ответ на обычный текст: бот — не мастер, сообщения здесь не читают. */
function notReadMessage({ salon, appUrl }) {
  const username = clean(salon?.master_username);
  const text = [
    "Я бот — сообщения в этом чате никто не читает.",
    "",
    username
      ? `Написать мастеру: @${username}. Записаться, перенести или отменить запись — в приложении.`
      : "Записаться, перенести или отменить запись — в приложении.",
  ].join("\n");
  return { text, reply_markup: menuKeyboard(appUrl) };
}

const COMMAND_SECTIONS = { book: "book", contacts: "contacts", privacy: "privacy" };

/**
 * Что ответить на апдейт Telegram: [{ method, body }] — вызовы Bot API по
 * порядку, пустой массив — молчать. Пишем только в личный чат.
 */
export function botReplies(update, { salon = null, appUrl = "", privacyUrl = "" } = {}) {
  const ctx = { salon, appUrl, privacyUrl };

  const cq = update?.callback_query;
  if (cq) {
    const calls = [{ method: "answerCallbackQuery", body: { callback_query_id: cq.id } }];
    const msg = cq.message;
    if (!msg?.chat || msg.chat.type !== "private") return calls;
    const data = typeof cq.data === "string" ? cq.data : "";
    const next =
      data === "menu" ? menuMessage(ctx) : data.startsWith("i:") ? sectionMessage(data.slice(2), ctx) : null;
    if (next) {
      calls.push({
        method: "editMessageText",
        body: { chat_id: msg.chat.id, message_id: msg.message_id, ...next },
      });
    }
    return calls;
  }

  const msg = update?.message;
  if (!msg?.chat || msg.chat.type !== "private") return [];
  const send = (m) => [{ method: "sendMessage", body: { chat_id: msg.chat.id, ...m } }];
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (text.startsWith("/")) {
    // "/book@my_bot аргументы" → "book"
    const command = text.slice(1).split(/[\s@]/)[0].toLowerCase();
    const section = Object.hasOwn(COMMAND_SECTIONS, command) ? COMMAND_SECTIONS[command] : null;
    return send(section ? sectionMessage(section, ctx) : menuMessage(ctx));
  }
  // Сервисные апдейты (данные мини-аппа и т. п.) — без ответа.
  if (msg.web_app_data) return [];
  return send(notReadMessage(ctx));
}
