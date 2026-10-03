import { CLIENT, bookingRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Записи клиента живут только на сервере (src/bookings.js): «Мои записи»
// и главная читают свои строки bookings по user_id, заявка сохраняется
// в базе ДО сообщения мастеру, отмена — cancel_own_booking(id). Решение
// мастера клиент узнаёт тостом — по сравнению с тем, что уже видел.

/** Ключ "ГГГГ-ММ-ДД" через несколько дней — с запасом от смены суток. */
function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY = dayKey(3);
const OTHER_USER = "00000000-0000-4000-8000-000000000099";

const mine = (id, fields = {}) => bookingRow(id, { day: DAY, user_id: CLIENT.id, ...fields });

const openMyBookings = (page) => page.getByRole("button", { name: /Мои записи/ }).click();

/** Вместо чата с мастером (sendToMaster → window.open без Telegram) — счётчик. */
async function stubChat(page) {
  await page.evaluate(() => {
    window.__chats = 0;
    window.open = () => {
      window.__chats += 1;
      return null;
    };
  });
}

/** Главная → услуга → первый день со свободным временем → первое окошко. */
async function reachConfirm(page) {
  await page.getByRole("button", { name: "Записаться" }).click();
  await page.getByRole("button", { name: /Маникюр/ }).click();
  await page.locator(".day-row:not([disabled])").first().click();
  await page.locator(".slot").first().click();
  await expect(page.getByRole("heading", { name: "Подтвердите заявку" })).toBeVisible();
}

test.describe("Мини-апп: записи с сервера", () => {
  test.describe("свои и чужие строки", () => {
    // Кортеж [значение, опции]: массив из нескольких строк Playwright
    // иначе сам принял бы за такой кортеж.
    test.use({
      bookings: [
        [
          mine(1, { status: "ok" }),
          bookingRow(2, { day: DAY, start_min: 720, user_id: OTHER_USER }),
          mine(3, { start_min: 840, status: "cancelled", cancelled_by: "client" }),
        ],
        { option: true },
      ],
    });

    test("видны только свои, без тоста при первом открытии", async ({ miniapp }) => {
      const { page } = miniapp;
      await expect(page.getByText("Ближайшая запись · подтверждена")).toBeVisible();
      // Устройство видит записи впервые — менять тостом нечего.
      await expect(page.getByText("Запись подтверждена ✓")).toBeHidden();

      await openMyBookings(page);
      // Чужая строка не пришла, отменённая самим клиентом — скрыта.
      const cards = page.locator(".book-card");
      await expect(cards).toHaveCount(1);
      await expect(cards).toContainText("Запись подтверждена");
      await expect(cards).toContainText("10:00");
    });
  });

  test.describe("мастер решает, пока клиент на главной", () => {
    test.use({ fakeClock: true, bookings: [mine(1)] });

    test("подтвердила — тост появляется сам", async ({ miniapp }) => {
      const { page, backend } = miniapp;
      await expect(page.getByText("Ближайшая запись · ожидает подтверждения")).toBeVisible();

      backend.tables.bookings[0].status = "ok";
      await page.clock.fastForward(20_000);
      await expect(page.getByText("Запись подтверждена ✓")).toBeVisible();
      await expect(page.getByText("Ближайшая запись · подтверждена")).toBeVisible();
    });

    test("перенесла — новые день и время в тосте и в «Мои записи»", async ({ miniapp }) => {
      const { page, backend } = miniapp;
      await expect(page.getByText("Ближайшая запись")).toBeVisible();

      Object.assign(backend.tables.bookings[0], { day: dayKey(5), start_min: 840, status: "ok" });
      await page.clock.fastForward(20_000);
      await expect(page.getByText(/Мастер перенесла запись: .*14:00/)).toBeVisible();

      await openMyBookings(page);
      await expect(page.locator(".book-card")).toContainText("14:00");
    });

    test("отклонила — «Отменена мастером», без кнопки отмены", async ({ miniapp }) => {
      const { page, backend } = miniapp;
      await expect(page.getByText("Ближайшая запись")).toBeVisible();

      Object.assign(backend.tables.bookings[0], { status: "cancelled", cancelled_by: "master" });
      await page.clock.fastForward(20_000);
      await expect(page.getByText("Мастер отменила запись")).toBeVisible();
      // На главной отменённая запись не «ближайшая».
      await expect(page.getByText("Ближайшая запись")).toBeHidden();

      await openMyBookings(page);
      const card = page.locator(".book-card");
      await expect(card).toContainText("Отменена мастером");
      await expect(card.getByRole("button", { name: "Отменить" })).toHaveCount(0);
    });
  });

  test.describe("решение мастера между запусками", () => {
    test.use({ bookings: [mine(1)] });

    test("тост при следующем открытии", async ({ miniapp }) => {
      const { page, backend } = miniapp;
      await expect(page.getByText("Ближайшая запись · ожидает подтверждения")).toBeVisible();

      backend.tables.bookings[0].status = "ok";
      await page.reload();
      await expect(page.getByText("Запись подтверждена ✓")).toBeVisible();
    });
  });

  test("заявка сохраняется в базе до сообщения мастеру", async ({ miniapp }) => {
    const { page, backend } = miniapp;
    await stubChat(page);
    await reachConfirm(page);
    await page.getByRole("button", { name: "Отправить заявку" }).click();

    await expect.poll(() => page.evaluate(() => window.__chats)).toBe(1);
    expect(backend.tables.bookings).toHaveLength(1);
    expect(backend.tables.bookings[0]).toMatchObject({
      user_id: CLIENT.id,
      service_id: "manicure",
      status: "new",
      source: "client",
    });
    // Имя, юзернейм и владельца ставит сервер — клиент их не присылает.
    const sent = backend.inserts.find((i) => i.table === "bookings").body;
    expect(sent).not.toHaveProperty("client_name");
    expect(sent).not.toHaveProperty("client_username");
    expect(sent).not.toHaveProperty("user_id");
    // Главная берёт запись из ответа вставки — без лишнего запроса.
    await expect(page.getByText("Ближайшая запись · ожидает подтверждения")).toBeVisible();
    await expect(page.getByText("Заявка сохранена")).toBeVisible();
  });

  test("сервер отказал — сообщение не уходит, «Повторить» отправляет", async ({ miniapp }) => {
    const { page, backend } = miniapp;
    await stubChat(page);
    await reachConfirm(page);

    backend.failBookingInsert = "Слишком много заявок — попробуйте позже";
    await page.getByRole("button", { name: "Отправить заявку" }).click();
    await expect(page.getByRole("alert")).toContainText("Слишком много заявок");
    expect(backend.tables.bookings).toHaveLength(0);
    expect(await page.evaluate(() => window.__chats)).toBe(0);

    backend.failBookingInsert = null;
    await page.getByRole("button", { name: "Повторить" }).click();
    await expect.poll(() => page.evaluate(() => window.__chats)).toBe(1);
    expect(backend.tables.bookings).toHaveLength(1);
  });

  test.describe("клиент отменяет сам", () => {
    test.use({ bookings: [mine(7)] });

    test("отмена по id отмечается на сервере", async ({ miniapp }) => {
      const { page, backend } = miniapp;
      // Первый confirm — «Отменить запись?», второй — «Сообщить об отмене…»:
      // от второго отказываемся, чтобы не открывать t.me.
      page.on("dialog", (d) => (d.message().startsWith("Сообщить") ? d.dismiss() : d.accept()));

      await openMyBookings(page);
      await page.locator(".book-card").getByRole("button", { name: "Отменить" }).click();

      await expect(page.getByText("Владислава увидит это в кабинете")).toBeVisible();
      expect(backend.rpcs.filter((r) => r.name === "cancel_own_booking")).toEqual([
        { name: "cancel_own_booking", body: { p_id: 7 } },
      ]);
      expect(backend.tables.bookings[0]).toMatchObject({
        status: "cancelled",
        cancelled_by: "client",
        cancel_seen: false,
      });
      await expect(page.locator(".book-card")).toHaveCount(0);
    });
  });

  test.describe("клиент переносит сам", () => {
    test.use({ bookings: [mine(8, { status: "ok" })] });

    /** «Мои записи» → «Перенести» → первый свободный день → первое окошко. */
    async function reachMove(page) {
      await openMyBookings(page);
      await page.locator(".book-card").getByRole("button", { name: "Перенести" }).click();
      await page.locator(".day-row:not([disabled])").first().click();
      await page.locator(".slot").first().click();
      await expect(page.getByRole("heading", { name: "Подтвердите перенос" })).toBeVisible();
    }

    test("перенос по id — на сервере до сообщения, запись снова ждёт мастера", async ({
      miniapp,
    }) => {
      const { page, backend } = miniapp;
      await stubChat(page);
      await reachMove(page);
      await expect(page.locator(".msg-preview")).toContainText("Хочу перенести запись");

      await page.getByRole("button", { name: "Перенести запись" }).click();
      await expect.poll(() => page.evaluate(() => window.__chats)).toBe(1);

      const calls = backend.rpcs.filter((r) => r.name === "reschedule_own_booking");
      expect(calls).toHaveLength(1);
      // Только id, день и минута — ни владельца, ни цены, ни статуса.
      expect(Object.keys(calls[0].body).sort()).toEqual(["p_day", "p_id", "p_start_min"]);
      expect(calls[0].body.p_id).toBe(8);
      expect(backend.tables.bookings[0].status).toBe("new");
      await expect(page.getByText("Запрос на перенос сохранён")).toBeVisible();
      await expect(page.getByText("Ближайшая запись · ожидает подтверждения")).toBeVisible();
    });

    test("сервер не признал запись своей (403) — сообщение не уходит", async ({ miniapp }) => {
      const { page, backend } = miniapp;
      await stubChat(page);
      await reachMove(page);

      // Запись «ушла» другому аккаунту, пока экран был открыт.
      backend.tables.bookings[0].user_id = "00000000-0000-4000-8000-000000000099";
      await page.getByRole("button", { name: "Перенести запись" }).click();

      await expect(page.getByRole("alert")).toContainText("Нет доступа");
      expect(await page.evaluate(() => window.__chats)).toBe(0);
      expect(backend.tables.bookings[0].day).toBe(DAY);
    });
  });
});
