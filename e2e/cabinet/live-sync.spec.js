import { bookingRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Кабинет сам подтягивает заявки и отмены клиентов (pollAdminData в
// src/admin/store.js) — без перезагрузки и без ухода со вкладки.

function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY = dayKey(3);
const TOKEN = "11111111-2222-4333-8444-555555555555";
const POLL_MS = 20_000;

test.use({ fakeClock: true });

test.describe("Кабинет: живая синхронизация", () => {
  test("новая заявка клиента появляется сама", async ({ cabinet }) => {
    const { page, backend, openTab } = cabinet;
    await openTab("Заявки");
    await expect(page.getByText("Новых заявок нет")).toBeVisible();

    backend.tables.bookings.push(
      bookingRow(1, { day: DAY, client_name: "Анна", client_token: TOKEN })
    );
    await page.clock.runFor(POLL_MS);

    await expect(page.locator(".request-card", { hasText: "Анна" })).toBeVisible();
    await expect(page.locator(".bottom-nav-badge")).toHaveText("1");
  });

  test.describe("клиент отменил запись", () => {
    test.use({
      bookings: [
        bookingRow(1, { day: DAY, client_name: "Анна", client_token: TOKEN, status: "ok" }),
      ],
    });

    test("отмена появляется в «Отменах» сама", async ({ cabinet }) => {
      const { page, backend, openTab } = cabinet;
      await openTab("Заявки");
      await expect(page.getByText("Отмены", { exact: true })).toBeHidden();

      Object.assign(backend.tables.bookings[0], {
        status: "cancelled",
        cancelled_by: "client",
        cancel_seen: false,
      });
      await page.clock.runFor(POLL_MS);

      await expect(page.getByText("Отмены", { exact: true })).toBeVisible();
      await expect(
        page.locator(".request-card", { hasText: "Клиент отменил запись" })
      ).toContainText("Анна");
    });
  });

  test("скрытая вкладка не опрашивает", async ({ cabinet }) => {
    const { page } = cabinet;
    await page.evaluate(() =>
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      })
    );
    let reads = 0;
    page.on("request", (req) => {
      if (req.method() === "GET" && req.url().includes("/rest/v1/bookings")) reads++;
    });

    await page.clock.runFor(POLL_MS * 3);
    expect(reads).toBe(0);
  });
});
