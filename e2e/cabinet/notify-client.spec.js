import { CLIENT, bookingRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Клиенту из мини-аппа с Telegram-логином кабинет после решения мастера
// сам открывает чат с готовым текстом (notifyClient в src/admin/messages.js),
// как клиент — мастеру. Без логина или без user_id — как раньше, тост.

const AHEAD = 3;

function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Аккаунт клиента мини-аппа, оставившего заявку (bookings.user_id).
const USER_ID = CLIENT.id;
const fromMiniApp = (fields = {}) =>
  bookingRow(1, {
    day: dayKey(AHEAD),
    client_name: "Анна",
    client_username: "anna_nails",
    user_id: USER_ID,
    ...fields,
  });

/** Панель дня в «Расписании» открыта на сегодня — листаем до дня записи. */
async function openBookingDay(page) {
  for (let i = 0; i < AHEAD; i++) {
    await page.getByRole("button", { name: "Следующий день" }).click();
  }
  return page.locator(".day-row", { hasText: "Анна" });
}

test.describe("Кабинет: чат с клиентом после решения", () => {
  test.describe("заявка из мини-аппа с логином", () => {
    test.use({ bookings: [fromMiniApp()] });

    test("«Подтвердить» — сначала запись в базу, потом чат", async ({ cabinet }) => {
      const { page, backend, openTab, openedChats } = cabinet;
      await openTab("Заявки");
      await page.getByRole("button", { name: "Подтвердить", exact: true }).click();

      await expect(page.getByText("открываем чат с клиентом")).toBeVisible();
      expect(backend.rpcs).toContainEqual({ name: "approve_booking", body: { p_id: 1 } });
      const chats = await openedChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].username).toBe("anna_nails");
      expect(chats[0].text).toContain("Здравствуйте, Анна!");
      expect(chats[0].text).toContain("Подтверждаю вашу запись");
      expect(chats[0].text).toContain("Маникюр");
      expect(chats[0].text).toContain("Владислава");
    });

    test("«Отклонить» — сообщение об отказе", async ({ cabinet }) => {
      const { page, backend, openTab, openedChats } = cabinet;
      await openTab("Заявки");
      await page.getByRole("button", { name: "Отклонить" }).click();

      await expect(page.getByText("открываем чат с клиентом")).toBeVisible();
      expect(backend.changes).toEqual([
        {
          method: "PATCH",
          table: "bookings",
          id: 1,
          body: { status: "cancelled", cancelled_by: "master", cancel_seen: true },
        },
      ]);
      const chats = await openedChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].text).toContain("не получится записать вас на это время");
    });

    test("«Изменить» → «Подтвердить запись» — в чат уходит текст из предпросмотра", async ({
      cabinet,
    }) => {
      const { page, backend, openTab, openedChats } = cabinet;
      await openTab("Заявки");
      await page.getByRole("button", { name: "Изменить" }).click();

      const preview = page.locator(".bk-msg");
      await expect(preview).toContainText("Подтверждаю вашу запись");
      await expect(page.getByText("откроется чат с @anna_nails")).toBeVisible();
      const shown = await preview.textContent();

      await page.getByRole("button", { name: "Подтвердить запись" }).click();
      await expect(page.getByText("открываем чат с клиентом")).toBeVisible();
      expect(backend.rpcs.map((r) => r.name)).toContain("update_master_booking");
      expect(await openedChats()).toEqual([{ username: "anna_nails", text: shown }]);
    });
  });

  test.describe("подтверждённая запись из мини-аппа", () => {
    test.use({ bookings: [fromMiniApp({ status: "ok" })] });

    test("«Отменить запись» в листе — сообщение об отмене", async ({ cabinet }) => {
      const { page, openedChats } = cabinet;
      const row = await openBookingDay(page);
      await row.getByRole("button", { name: "Изменить" }).click();
      await page.getByRole("button", { name: "Отменить запись" }).click();
      await page.getByRole("button", { name: "Да, отменить" }).click();

      await expect(page.getByText("открываем чат с клиентом")).toBeVisible();
      const chats = await openedChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].text).toContain("вашу запись пришлось отменить");
    });

    test("корзина в панели дня — тоже сообщение об отмене", async ({ cabinet }) => {
      const { page, backend, openedChats } = cabinet;
      const row = await openBookingDay(page);
      await row.getByRole("button", { name: "Удалить запись" }).click();
      await expect(row).toContainText("Откроется чат с клиентом");
      await row.getByRole("button", { name: "Удалить", exact: true }).click();

      await expect(page.getByText("открываем чат с клиентом")).toBeVisible();
      expect(backend.changes.map((c) => c.method)).toEqual(["PATCH"]);
      const chats = await openedChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].text).toContain("вашу запись пришлось отменить");
    });
  });

  test.describe("заявка из мини-аппа без логина", () => {
    test.use({ bookings: [fromMiniApp({ client_username: "" })] });

    test("чат не открывается — клиент увидит решение в «Мои записи»", async ({ cabinet }) => {
      const { page, openTab, openedChats } = cabinet;
      await openTab("Заявки");
      await page.getByRole("button", { name: "Подтвердить", exact: true }).click();

      await expect(page.getByText("клиент увидит это в «Мои записи»")).toBeVisible();
      expect(await openedChats()).toEqual([]);
    });
  });

  test.describe("запись без user_id", () => {
    test.use({ bookings: [fromMiniApp({ user_id: null })] });

    test("чат не открывается, даже если логин есть", async ({ cabinet }) => {
      const { page, openTab, openedChats } = cabinet;
      await openTab("Заявки");
      await page.getByRole("button", { name: "Отклонить" }).click();

      await expect(page.getByText("Напишите клиенту в чате")).toBeVisible();
      expect(await openedChats()).toEqual([]);
    });
  });
});
