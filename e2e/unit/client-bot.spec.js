import { expect, test } from "@playwright/test";
import {
  BOT_COMMANDS,
  BOT_DESCRIPTION,
  BOT_SHORT_DESCRIPTION,
  botReplies,
  sectionMessage,
} from "../../supabase/functions/_shared/client-bot.js";

// Бот клиента (supabase/functions/_shared/client-bot.js) — что он отвечает
// на команды, кнопки и обычный текст; тот же код, что исполняет Edge
// Function client-bot. Сети нет: проверяем список вызовов Bot API.

const APP = "https://example.com/app";

const salon = (over = {}) => ({
  master_name: "Владислава",
  master_username: "vlada_nails",
  master_phone: "+7 900 000-00-00",
  address: "Москва, ул. Пример, 12",
  landmark: "Домофон 5",
  transport: "",
  map_url: "https://maps.example.com/x",
  working_hours_text: "Пн–Сб 10:00–19:00",
  reminder_hours: 24,
  ...over,
});

const message = (text, chat = { id: 4242, type: "private" }) => ({ message: { message_id: 1, chat, text } });
const tap = (data) => ({
  callback_query: { id: "cq1", data, message: { message_id: 9, chat: { id: 4242, type: "private" } } },
});
const buttons = (markup) => markup.inline_keyboard.flat();

test("описание и команды укладываются в лимиты Telegram", () => {
  expect(BOT_DESCRIPTION.length).toBeLessThanOrEqual(512);
  expect(BOT_SHORT_DESCRIPTION.length).toBeLessThanOrEqual(120);
  for (const c of BOT_COMMANDS) {
    expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(c.description.length).toBeLessThanOrEqual(256);
  }
});

test("/start и /help — меню с кнопками разделов и «Открыть запись»", () => {
  for (const text of ["/start", "/help", "/start payload", "/START@my_bot"]) {
    const [call] = botReplies(message(text), { salon: salon(), appUrl: APP });
    expect(call.method).toBe("sendMessage");
    expect(call.body.chat_id).toBe(4242);
    expect(call.body.text).toContain("Владислава");
    const all = buttons(call.body.reply_markup);
    expect(all[0]).toEqual({ text: "Открыть запись", web_app: { url: APP } });
    expect(all.map((b) => b.callback_data).filter(Boolean)).toEqual([
      "i:book",
      "i:move",
      "i:remind",
      "i:contacts",
      "i:privacy",
    ]);
  }
});

test("без https-адреса приложения кнопки «Открыть запись» нет", () => {
  const [call] = botReplies(message("/start"), { appUrl: "http://insecure" });
  expect(buttons(call.body.reply_markup).some((b) => b.web_app)).toBe(false);
});

test("кнопка раздела правит то же сообщение, «Назад» возвращает меню", () => {
  const calls = botReplies(tap("i:book"), { salon: salon(), appUrl: APP });
  expect(calls[0]).toEqual({ method: "answerCallbackQuery", body: { callback_query_id: "cq1" } });
  expect(calls[1].method).toBe("editMessageText");
  expect(calls[1].body).toMatchObject({ chat_id: 4242, message_id: 9 });
  expect(calls[1].body.text).toContain("Как записаться");
  expect(buttons(calls[1].body.reply_markup)).toContainEqual({ text: "← Назад", callback_data: "menu" });

  const back = botReplies(tap("menu"), { salon: salon(), appUrl: APP });
  expect(back[1].body.text).toContain("Здравствуйте");

  // Неизвестная кнопка — только убрать «часики».
  expect(botReplies(tap("i:nope"))).toHaveLength(1);
});

test("команды разделов", () => {
  expect(botReplies(message("/book"))[0].body.text).toContain("Как записаться");
  expect(botReplies(message("/contacts"), { salon: salon() })[0].body.text).toContain("📍 Москва, ул. Пример, 12");
  expect(botReplies(message("/privacy"))[0].body.text).toContain("Ваши данные");
});

test("напоминания: часы из настроек, 0 — выключены, без базы — без цифр", () => {
  expect(sectionMessage("remind", { salon: salon() }).text).toContain("примерно за 24 часа до начала");
  expect(sectionMessage("remind", { salon: salon({ reminder_hours: 1 }) }).text).toContain("за 1 час");
  expect(sectionMessage("remind", { salon: salon({ reminder_hours: 5 }) }).text).toContain("за 5 часов");
  expect(sectionMessage("remind", { salon: salon({ reminder_hours: 0 }) }).text).toContain("выключены");
  expect(sectionMessage("remind").text).toContain("незадолго до начала");
});

test("контакты: только заполненные поля; пусто — отсылка в приложение", () => {
  const text = sectionMessage("contacts", { salon: salon() }).text;
  expect(text).toContain("Домофон 5");
  expect(text).toContain("@vlada_nails");
  expect(text).not.toContain("🚌");
  const empty = sectionMessage("contacts", {
    salon: salon({ master_name: "", master_username: "", master_phone: "", address: "", landmark: "", map_url: "", working_hours_text: "" }),
  }).text;
  expect(empty).toContain("«Важная информация»");
});

test("данные: ссылка на политику — только https", () => {
  expect(sectionMessage("privacy", { privacyUrl: "https://example.com/privacy.html" }).text).toContain(
    "https://example.com/privacy.html"
  );
  expect(sectionMessage("privacy", { privacyUrl: "javascript:alert(1)" }).text).not.toContain("javascript");
});

test("обычный текст — бот не мастер, подсказка с логином мастера", () => {
  const [call] = botReplies(message("Здравствуйте, можно на завтра?"), { salon: salon() });
  expect(call.body.text).toContain("никто не читает");
  expect(call.body.text).toContain("@vlada_nails");
});

test("группы, сервисные апдейты и мусор — молчим", () => {
  expect(botReplies(message("/start", { id: -100, type: "group" }))).toEqual([]);
  expect(botReplies({ message: { chat: { id: 1, type: "private" }, web_app_data: { data: "x" } } })).toEqual([]);
  expect(botReplies({})).toEqual([]);
  expect(botReplies(null)).toEqual([]);
});
