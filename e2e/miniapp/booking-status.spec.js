import { bookingRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Решение мастера → клиенту: syncBookings() (src/sync.js) спрашивает
// booking_status() при запуске мини-аппа и показывает изменения тостом;
// отмена клиентом — cancel_own_booking() до сообщения мастеру.

/** Ключ "ГГГГ-ММ-ДД" через несколько дней — с запасом от смены суток. */
function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY = dayKey(3);
const TOKEN = "11111111-2222-4333-8444-555555555555";

const local = (fields = {}) => ({
  id: "1700000000000",
  s: "manicure",
  d: DAY,
  t: "10:00",
  m: 90,
  p: 60,
  c: "",
  k: TOKEN,
  st: "new",
  ...fields,
});

const openMyBookings = (page) => page.getByRole("button", { name: /Мои записи/ }).click();

test.describe("Мини-апп: статус записи", () => {
  test.describe("мастер подтвердила", () => {
    test.use({
      localBookings: [local()],
      bookings: [bookingRow(1, { day: DAY, client_token: TOKEN, status: "ok" })],
    });

    test("тост на главной и «подтверждена» в «Мои записи»", async ({ miniapp }) => {
      const { page } = miniapp;
      await expect(page.getByText("Запись подтверждена ✓")).toBeVisible();
      await expect(page.getByText("Ближайшая запись · подтверждена")).toBeVisible();

      const [stored] = await miniapp.stored();
      expect(stored).toMatchObject({ st: "ok", sv: true });

      await openMyBookings(page);
      await expect(page.locator(".book-card")).toContainText("Запись подтверждена");
    });
  });

  test.describe("мастер подтвердила, пока клиент на главной", () => {
    test.use({
      fakeClock: true,
      localBookings: [local()],
      bookings: [bookingRow(1, { day: DAY, client_token: TOKEN, status: "new" })],
    });

    test("тост появляется сам, без перезапуска", async ({ miniapp }) => {
      const { page, backend } = miniapp;
      await expect(page.getByText("Ближайшая запись · ожидает подтверждения")).toBeVisible();

      backend.tables.bookings[0].status = "ok";
      await page.clock.fastForward(20_000);
      await expect(page.getByText("Запись подтверждена ✓")).toBeVisible();
      await expect(page.getByText("Ближайшая запись · подтверждена")).toBeVisible();
    });
  });

  test.describe("мастер перенесла подтверждённую запись", () => {
    const NEW_DAY = dayKey(5);
    test.use({
      localBookings: [local({ st: "ok", sv: true })],
      bookings: [bookingRow(1, { day: NEW_DAY, start_min: 840, client_token: TOKEN, status: "ok" })],
    });

    test("новые день и время — на устройстве и в тосте", async ({ miniapp }) => {
      const { page } = miniapp;
      await expect(page.getByText(/Мастер перенесла запись: .*14:00/)).toBeVisible();

      const [stored] = await miniapp.stored();
      expect(stored).toMatchObject({ d: NEW_DAY, t: "14:00", st: "ok", sv: true });
      expect(stored).not.toHaveProperty("moved");

      await openMyBookings(page);
      await expect(page.locator(".book-card")).toContainText("14:00");
    });
  });

  test.describe("мастер отклонила", () => {
    test.use({
      localBookings: [local()],
      bookings: [
        bookingRow(1, { day: DAY, client_token: TOKEN, status: "cancelled", cancelled_by: "master" }),
      ],
    });

    test("карточка «Отменена мастером», «Убрать» её убирает", async ({ miniapp }) => {
      const { page } = miniapp;
      await expect(page.getByText("Мастер отменила запись")).toBeVisible();
      // На главной отменённая запись не «ближайшая».
      await expect(page.getByText("Ближайшая запись")).toBeHidden();

      await openMyBookings(page);
      const card = page.locator(".book-card");
      await expect(card).toContainText("Отменена мастером");
      await card.getByRole("button", { name: "Убрать" }).click();
      await expect(card).toHaveCount(0);
      expect(await miniapp.stored()).toEqual([]);
    });
  });

  test.describe("заявка не доехала до базы", () => {
    test.use({ localBookings: [local()] });

    test("досылается при следующем открытии", async ({ miniapp }) => {
      const { page, backend } = miniapp;
      await expect.poll(() => backend.inserts.length).toBe(1);
      expect(backend.inserts[0].body).toMatchObject({
        day: DAY,
        start_min: 600,
        service_id: "manicure",
        client_token: TOKEN,
        status: "new",
        source: "client",
      });
      await expect.poll(async () => (await miniapp.stored())[0].sv).toBe(true);
      // Статус не выдуман: заявка по-прежнему ждёт мастера.
      await openMyBookings(page);
      await expect(page.locator(".book-card")).toContainText("Ожидает подтверждения");
    });
  });

  test.describe("клиент отменяет сам", () => {
    test.use({
      localBookings: [local({ sv: true })],
      bookings: [bookingRow(1, { day: DAY, client_token: TOKEN, status: "new" })],
    });

    test("отмена отмечается на сервере", async ({ miniapp }) => {
      const { page, backend } = miniapp;
      // Первый confirm — «Отменить запись?», второй — «Сообщить об отмене…»:
      // от второго отказываемся, чтобы не открывать t.me.
      page.on("dialog", (d) => (d.message().startsWith("Сообщить") ? d.dismiss() : d.accept()));

      await openMyBookings(page);
      await page.locator(".book-card").getByRole("button", { name: "Отменить" }).click();

      await expect(page.getByText("Владислава увидит это в кабинете")).toBeVisible();
      expect(backend.rpcs.filter((r) => r.name === "cancel_own_booking")).toEqual([
        { name: "cancel_own_booking", body: { p_token: TOKEN } },
      ]);
      expect(backend.tables.bookings[0]).toMatchObject({
        status: "cancelled",
        cancelled_by: "client",
        cancel_seen: false,
      });
      expect(await miniapp.stored()).toEqual([]);
    });
  });
});
