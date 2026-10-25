import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import {
  ENABLED,
  IT,
  LOCAL_ONLY,
  admin,
  api,
  asRow,
  bookingAsAdmin,
  insertBooking,
  rpc,
  signIn,
  tgUser,
  wipeBookings,
  workdays,
} from "./support.js";

// Клиент, которого мастер завела сама, и его аккаунт в мини-аппе
// (supabase/schema.sql «Карточка клиента и его аккаунт мини-аппа»).
// Записи карточки клиент видит в «Мои записи», только когда она привязана
// к его аккаунту:
//   1. клиента ещё нет в приложении — мастер шлёт ссылку на бота, бот по
//      «Запустить» присылает приглашение с кнопками «Принять» / «Отклонить»;
//      принявший получает карточку при первом входе в приложение;
//   2. клиент уже в приложении — карточка привязывается сама, когда мастер
//      её сохраняет, а если у него уже своя карточка — бот сам присылает
//      ему приглашение (Edge Function api/invite).
// Настоящие Edge Functions api/bot и api/invite; Bot API подменён
// HTTP-сервером на хосте (TELEGRAM_API_URL в supabase/config.toml).

test.skip(!ENABLED, "нет SUPABASE_IT_* — локальный Supabase не поднят (см. support.js)");
test.skip(ENABLED && !LOCAL_ONLY, "SUPABASE_IT_URL должен указывать на локальный стек");

const BOT_PORT = 54399;
const WEBHOOK_SECRET = "local-test-webhook-secret"; // supabase/config.toml

let M; // мастер салона 1
const DAYS = workdays();
const DAY_2 = DAYS[DAYS.length - 1]; // для заявок клиентов
// Записи мастера — по одной на окно 10:00/12:00/14:00/16:00, день за днём.
let slot = 0;
const nextSlot = () => ({ day: DAYS[Math.floor(slot / 4)], start: 600 + (slot++ % 4) * 120 });
let last; // { day, start } последней записи masterBooksNewClient

/** Поддельный Bot API: журнал вызовов, ответ по chat_id. */
let server;
const calls = [];
const statusFor = new Map();
const botCalls = (method, chatId) =>
  calls.filter((c) => c.path.endsWith(`/${method}`) && (chatId == null || c.body.chat_id === chatId));

async function makeMaster(user) {
  await signIn(user);
  await admin(`/rest/v1/profiles?telegram_id=eq.${user.id}`, { method: "PATCH", body: { role: "master" } });
  return signIn(user);
}

/** Мастер записывает нового клиента (как «Записать» → «Новый клиент»). → id записи. */
async function masterBooksNewClient(name, telegram) {
  last = nextSlot();
  const res = await rpc(
    "create_master_booking",
    {
      p_client_id: null,
      p_new_name: name,
      p_new_phone: "",
      p_new_telegram: telegram,
      p_new_channel: "tg",
      p_service_id: "manicure",
      p_day: last.day,
      p_start_min: last.start,
      p_comment: "",
    },
    M.token
  );
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  return res.data;
}

/** «Пригласить в приложение» в кабинете → { status, data: { code, sent } | { error } }. */
const invite = (clientId, token = M.token) =>
  api("/functions/v1/api/invite", { method: "POST", token, body: { client_id: clientId } });

/** Апдейт Telegram вебхуку бота клиента салона 1. */
const webhook = (update) =>
  api("/functions/v1/api/bot", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
    body: { update_id: 1, ...update },
  });

const chat = (tg) => ({ id: tg.id, type: "private" });
/** Клиент открыл ссылку t.me/<бот>?start=c_<код> и нажал «Запустить». */
const pressStart = (tg, code) =>
  webhook({ message: { message_id: 1, chat: chat(tg), from: { id: tg.id }, text: `/start c_${code}` } });
/** Клиент нажал «Принять» / «Отклонить» под приглашением. */
const pressAnswer = (tg, code, accept) =>
  webhook({
    callback_query: {
      id: `cb-${tg.id}`,
      from: { id: tg.id },
      data: `inv:${accept ? "a" : "d"}:${code}`,
      message: { message_id: 7, chat: chat(tg) },
    },
  });
/** Последний текст, которым бот заменил приглашение у этого клиента. */
const editedText = (tg) => botCalls("editMessageText", tg.id).at(-1)?.body.text ?? "";

const clientCard = async (id) =>
  (await api(`/rest/v1/client_stats?id=eq.${id}&select=*`, { token: M.token })).data[0];

const myBookingIds = async (who) =>
  (await api("/rest/v1/bookings?select=id", { token: who.token })).data.map((r) => r.id);

test.beforeAll(async () => {
  if (!ENABLED || !LOCAL_ONLY) return;
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      calls.push({ path: req.url, body });
      const status = statusFor.get(body.chat_id) ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status === 200 }));
    });
  });
  await new Promise((resolve) => server.listen(BOT_PORT, "0.0.0.0", resolve));
  await wipeBookings();
  M = await makeMaster(tgUser("InviteMaster"));
});

test.afterAll(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

test.describe("1. клиента ещё нет в приложении — приглашение через бота", () => {
  test("ссылка → «Запустить» → «Принять» → записи у клиента после первого входа", async () => {
    const tg = tgUser("Invited");
    const bookingId = await masterBooksNewClient("Вероника", `@${tg.username}`);
    const { client_id: clientId } = await bookingAsAdmin(bookingId);
    expect(await clientCard(clientId)).toMatchObject({ in_app: false, app_match: false, invite_status: null });

    // Писать клиенту боту нельзя — кабинету код для ссылки.
    const inv = await invite(clientId);
    expect(inv.status).toBe(200);
    expect(inv.data).toEqual({ code: expect.stringMatching(/^[0-9a-f]{32}$/), sent: false });
    const { code } = inv.data;
    expect(botCalls("sendMessage", tg.id)).toEqual([]);
    expect(await clientCard(clientId)).toMatchObject({ invite_status: "pending" });

    expect((await pressStart(tg, code)).status).toBe(200);
    const [offer] = botCalls("sendMessage", tg.id);
    expect(offer.body.text).toContain("Здравствуйте, Вероника!");
    expect(offer.body.text).toContain("записала вас");
    expect(offer.body.reply_markup.inline_keyboard).toEqual([
      [
        { text: "✅ Принять", callback_data: `inv:a:${code}` },
        { text: "✖️ Отклонить", callback_data: `inv:d:${code}` },
      ],
    ]);

    await pressAnswer(tg, code, true);
    expect(botCalls("answerCallbackQuery").at(-1).body.callback_query_id).toBe(`cb-${tg.id}`);
    expect(editedText(tg)).toContain("Откройте приложение");
    // Аккаунта ещё нет — принял, ждём первого входа.
    expect(await clientCard(clientId)).toMatchObject({ in_app: false, invite_status: "accepted" });
    expect((await bookingAsAdmin(bookingId)).user_id).toBeNull();

    // Первый вход в мини-апп — карточка его.
    const C = await signIn(tg);
    expect(await myBookingIds(C)).toEqual([bookingId]);
    expect(await clientCard(clientId)).toMatchObject({ in_app: true, invite_status: null });

    // Повторное «Принять» — «уже», без ошибки.
    await pressAnswer(tg, code, true);
    expect(editedText(tg)).toContain("Ваши записи — в приложении");
  });

  test("«Отклонить» — код закрыт, карточка без аккаунта", async () => {
    const tg = tgUser("Declines");
    const bookingId = await masterBooksNewClient("Ирина", tg.username);
    const { client_id: clientId } = await bookingAsAdmin(bookingId);
    const { code } = (await invite(clientId)).data;

    await pressStart(tg, code);
    await pressAnswer(tg, code, false);
    expect(editedText(tg)).toContain("приглашение отклонено");
    expect(await clientCard(clientId)).toMatchObject({ in_app: false, invite_status: "declined" });

    await pressAnswer(tg, code, true);
    expect(editedText(tg)).toContain("Приглашение недействительно");
    const C = await signIn(tg);
    expect(await myBookingIds(C)).toEqual([]);

    // Мастер приглашает ещё раз — новый код, снова ждём.
    const again = (await invite(clientId)).data.code;
    expect(again).not.toBe(code);
    expect(await clientCard(clientId)).toMatchObject({ invite_status: "pending" });
  });

  test("принятое приглашение чужому не подходит, новое отменяет прежнее", async () => {
    const tg = tgUser("Owner");
    const bookingId = await masterBooksNewClient("Ольга", tg.username);
    const { client_id: clientId } = await bookingAsAdmin(bookingId);
    const first = (await invite(clientId)).data.code;
    const second = (await invite(clientId)).data.code;

    await pressAnswer(tg, first, true);
    expect(editedText(tg)).toContain("Приглашение недействительно");
    await pressAnswer(tg, second, true);
    expect(editedText(tg)).toContain("Откройте приложение");

    const stranger = tgUser("Stranger");
    await pressStart(stranger, second);
    expect(botCalls("sendMessage", stranger.id).at(-1).body.text).toContain("недействительно");
    await pressAnswer(stranger, second, true);
    expect(editedText(stranger)).toContain("Приглашение недействительно");

    const C = await signIn(tg);
    expect(await myBookingIds(C)).toEqual([bookingId]);
  });

  test("неверный код и мастер — «недействительно», ничего не меняется", async () => {
    const bookingId = await masterBooksNewClient("Дарья", tgUser("Darya").username);
    const { client_id: clientId } = await bookingAsAdmin(bookingId);
    const { code } = (await invite(clientId)).data;

    const nobody = tgUser("Nobody");
    await pressStart(nobody, "0".repeat(32));
    expect(botCalls("sendMessage", nobody.id).at(-1).body.text).toContain("недействительно");

    // Аккаунт мастера клиентом не становится.
    await pressAnswer(M.tg, code, true);
    expect(editedText(M.tg)).toContain("Приглашение недействительно");
    expect((await bookingAsAdmin(bookingId)).user_id).toBeNull();
    expect(await clientCard(clientId)).toMatchObject({ invite_status: "pending" });
  });

  test("без Telegram и уже в приложении — пригласить нельзя", async () => {
    const noTg = await masterBooksNewClient("Без телеграма", "");
    const res = await invite((await bookingAsAdmin(noTg)).client_id);
    expect(res).toEqual({
      status: 400,
      data: { error: "Укажите Telegram клиента — приглашение уходит ему в чат" },
    });

    const C = await signIn(tgUser("AlreadyIn"));
    const own = asRow(await insertBooking(C.token, { day: DAY_2, start_min: 720 }));
    expect(await invite(own.client_id)).toEqual({ status: 400, data: { error: "Клиент уже в приложении" } });
  });
});

test.describe("2. клиент уже в приложении", () => {
  test("мастер заводит клиента с его Telegram — запись сразу у клиента", async () => {
    const tg = tgUser("Registered");
    const C = await signIn(tg); // вошёл, но заявок не оставлял — карточки нет
    // Регистр и «@» не важны: Telegram их не различает.
    const bookingId = await masterBooksNewClient("Мария", `@${tg.username.toUpperCase()}`);
    const row = await bookingAsAdmin(bookingId);

    expect(row.user_id).toBe(C.uid);
    expect(await myBookingIds(C)).toEqual([bookingId]);
    expect(await clientCard(row.client_id)).toMatchObject({ in_app: true, app_match: false });
  });

  test("Telegram дописан в карточку позже — записи переходят к клиенту", async () => {
    const tg = tgUser("Later");
    const C = await signIn(tg);
    const bookingId = await masterBooksNewClient("Светлана", "");
    const { client_id: clientId } = await bookingAsAdmin(bookingId);

    const res = await api(`/rest/v1/clients?id=eq.${clientId}`, {
      method: "PATCH",
      token: M.token,
      body: { telegram_username: tg.username },
    });
    expect(res.status).toBe(204);
    expect((await bookingAsAdmin(bookingId)).user_id).toBe(C.uid);
    expect(await myBookingIds(C)).toEqual([bookingId]);
  });

  test("карточка была раньше аккаунта — бот сам присылает приглашение, «Принять» сливает карточки", async () => {
    const tg = tgUser("Merge");
    const masterBooking = await masterBooksNewClient("Вероника", tg.username);
    const { client_id: masterCard } = await bookingAsAdmin(masterBooking);

    // Клиент пришёл сам и оставил заявку — у неё своя карточка (юзернейм
    // уже занят карточкой мастера, поэтому без него). Вход сам ничего не
    // привязывает.
    const C = await signIn(tg);
    const own = asRow(await insertBooking(C.token, { day: DAY_2, start_min: 840 }));
    expect(own.client_id).not.toBe(masterCard);
    expect(await myBookingIds(C)).toEqual([own.id]);
    expect(await clientCard(masterCard)).toMatchObject({ in_app: false, app_match: true });
    await api("/rest/v1/client_comments", {
      method: "POST",
      token: M.token,
      body: { client_id: own.client_id, body: "пришла из приложения" },
    });

    const inv = await invite(masterCard);
    expect(inv.data).toEqual({ code: expect.any(String), sent: true });
    const [offer] = botCalls("sendMessage", tg.id);
    expect(offer.path).toContain("/bot111111:local-test-client-bot/");
    expect(offer.body.reply_markup.inline_keyboard[0][0].callback_data).toBe(`inv:a:${inv.data.code}`);

    await pressAnswer(tg, inv.data.code, true);
    expect(editedText(tg)).toContain("Ваши записи — в приложении");

    expect((await myBookingIds(C)).sort()).toEqual([masterBooking, own.id].sort());
    expect((await bookingAsAdmin(own.id)).client_id).toBe(masterCard);
    expect(await clientCard(masterCard)).toMatchObject({
      in_app: true,
      app_match: false,
      name: "Вероника",
      telegram_username: tg.username,
    });
    expect(await clientCard(own.client_id)).toBeUndefined();
    const notes = await api(`/rest/v1/client_comments?client_id=eq.${masterCard}&select=body`, {
      token: M.token,
    });
    expect(notes.data).toEqual([{ body: "пришла из приложения" }]);

    // Следующая заявка клиента попадает в ту же карточку.
    const later = asRow(await insertBooking(C.token, { day: DAY_2, start_min: 960 }));
    expect(later.client_id).toBe(masterCard);
  });

  test("бот остановлен (Telegram 403) — sent: false и отметка", async () => {
    const tg = tgUser("Blocked");
    const bookingId = await masterBooksNewClient("Нина", tg.username);
    const C = await signIn(tg);
    asRow(await insertBooking(C.token, { day: DAY_2, start_min: 1080 }));
    statusFor.set(tg.id, 403);

    const inv = await invite((await bookingAsAdmin(bookingId)).client_id);
    expect(inv.data.sent).toBe(false);
    const prof = (await admin(`/rest/v1/profiles?id=eq.${C.uid}&select=bot_unreachable_at`)).data[0];
    expect(prof.bot_unreachable_at).not.toBeNull();
  });
});

test.describe("права", () => {
  test("приглашает только мастер; функции бота — только service role", async () => {
    const tg = tgUser("Rights");
    const bookingId = await masterBooksNewClient("Права", tg.username);
    const { client_id: clientId } = await bookingAsAdmin(bookingId);
    const { code } = (await invite(clientId)).data;
    const C = await signIn(tg);

    expect((await rpc("create_client_invite", { p_client_id: clientId }, C.token)).status).toBe(403);
    expect((await invite(clientId, C.token)).status).toBe(403);
    expect((await api("/rest/v1/client_invites?select=*", { token: C.token })).data).toEqual([]);

    const botCallsAs = [
      ["bot_client_invite", { p_salon: 1, p_code: code, p_telegram_id: tg.id }],
      ["bot_answer_client_invite", { p_salon: 1, p_code: code, p_telegram_id: tg.id, p_accept: true }],
      ["bot_invite_recipient", { p_code: code }],
    ];
    for (const [name, args] of botCallsAs) {
      expect((await rpc(name, args, C.token)).status, `${name} клиентом`).toBe(403);
      expect((await rpc(name, args, M.token)).status, `${name} мастером`).toBe(403);
      expect((await rpc(name, args)).status, `${name} анонимом`).toBe(401);
    }
    expect((await rpc("bot_client_invite", botCallsAs[0][1], IT.service)).data[0].status).toBe("open");
    expect((await bookingAsAdmin(bookingId)).user_id).toBeNull();

    // Чужой секрет вебхука — 401, апдейт не обработан.
    const forged = await api("/functions/v1/api/bot", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      body: { callback_query: { id: "x", from: { id: tg.id }, data: `inv:a:${code}`, message: { message_id: 1, chat: chat(tg) } } },
    });
    expect(forged.status).toBe(401);
    expect(await clientCard(clientId)).toMatchObject({ in_app: false, invite_status: "pending" });
  });
});
