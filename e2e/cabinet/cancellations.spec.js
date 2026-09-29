import { bookingRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// «Заявки»: отмены клиентов (cancel_own_booking) — блок «Отмены» с
// «Понятно»; «Отклонить» у заявки из мини-аппа — status "cancelled"
// (cancelBooking в src/admin/api.js), у прочих — удаление, как раньше.

function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY = dayKey(3);
const TOKEN = "11111111-2222-4333-8444-555555555555";

test.describe("Кабинет: отмены и отклонённые заявки", () => {
  test.describe("клиент отменил запись", () => {
    test.use({
      bookings: [
        bookingRow(1, {
          day: DAY,
          client_name: "Анна",
          client_token: TOKEN,
          status: "cancelled",
          cancelled_by: "client",
        }),
      ],
    });

    test("видна в «Отменах», «Понятно» убирает её", async ({ cabinet }) => {
      const { page, backend, openTab } = cabinet;
      // Бейдж вкладки считает и непросмотренные отмены.
      await expect(page.locator(".bottom-nav-badge")).toHaveText("1");
      await openTab("Заявки");

      const card = page.locator(".request-card", { hasText: "Клиент отменил запись" });
      await expect(page.getByText("Отмены", { exact: true })).toBeVisible();
      await expect(card).toContainText("Анна");
      await card.getByRole("button", { name: "Понятно" }).click();

      await expect(card).toHaveCount(0);
      expect(backend.changes).toEqual([
        { method: "PATCH", table: "bookings", id: 1, body: { cancel_seen: true } },
      ]);
      await expect(page.locator(".bottom-nav-badge")).toHaveCount(0);
    });
  });

  test.describe("заявка из мини-аппа", () => {
    test.use({
      bookings: [bookingRow(1, { day: DAY, client_name: "Анна", client_token: TOKEN })],
    });

    test("«Отклонить» отменяет статусом, не удаляет", async ({ cabinet }) => {
      const { page, backend, openTab } = cabinet;
      await openTab("Заявки");
      await page.getByRole("button", { name: "Отклонить" }).click();

      await expect(page.getByText("клиент увидит это в «Мои записи»")).toBeVisible();
      expect(backend.changes).toEqual([
        {
          method: "PATCH",
          table: "bookings",
          id: 1,
          body: { status: "cancelled", cancelled_by: "master", cancel_seen: true },
        },
      ]);
      // Отменённая мастером — ни в заявках, ни в отменах.
      await expect(page.getByText("Новых заявок нет")).toBeVisible();
      await expect(page.getByText("Отмены", { exact: true })).toBeHidden();
    });
  });

  test.describe("заявка без client_token", () => {
    test.use({ bookings: [bookingRow(1, { day: DAY, client_name: "Анна" })] });

    test("«Отклонить» удаляет, как раньше", async ({ cabinet }) => {
      const { page, backend, openTab } = cabinet;
      await openTab("Заявки");
      await page.getByRole("button", { name: "Отклонить" }).click();

      await expect(page.getByText("Напишите клиенту в чате")).toBeVisible();
      expect(backend.changes).toEqual([{ method: "DELETE", table: "bookings", id: 1, body: null }]);
    });
  });
});
