import { monthTitle } from "../../src/admin/analytics.js";
import { bookingRow, clientRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Вкладка «Аналитика» (AnalyticsSection.jsx): считается из уже
// загруженных записей — визит это подтверждённая прошедшая запись.

function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const PAST = dayKey(-3);

// Список из нескольких строк — как [значение, опции] (см. fixtures.js).
test.use({
  clients: [
    [
      clientRow(1, { name: "Анна", telegram_username: "anna" }),
      clientRow(2, { name: "Вера", phone: "+995 555 11 22 33", channel: "wa" }),
    ],
    {},
  ],
  bookings: [
    [
      bookingRow(1, { day: PAST, status: "ok", source: "master", client_id: 1, price: 60 }),
      bookingRow(2, { day: dayKey(-4), status: "ok", source: "master", client_id: 1, price: 90 }),
      // Не визиты: заявка в прошлом и будущая подтверждённая.
      bookingRow(3, { day: dayKey(-2), status: "new", client_id: 2, price: 500 }),
      bookingRow(4, { day: dayKey(5), status: "ok", source: "master", client_id: 2, price: 500 }),
    ],
    {},
  ],
});

test.describe("Кабинет: аналитика", () => {
  test("заработано и плитки — только по визитам периода", async ({ cabinet }) => {
    const { page, openTab } = cabinet;
    await openTab("Аналитика");

    await expect(page.getByRole("heading", { name: "Аналитика" })).toBeVisible();
    await expect(page.locator(".header-name")).toHaveText("за 30 дней");
    await expect(page.locator(".an-revenue")).toHaveText(/^150\s₽$/);
    const tiles = page.locator(".an-tiles .stat-tile");
    await expect(tiles.nth(0)).toContainText("2Визитов");
    await expect(tiles.nth(1)).toContainText(/75\s₽/);
    await expect(tiles.nth(2)).toContainText("1Клиентов");

    await page.getByRole("button", { name: "Всё" }).click();
    await expect(page.locator(".header-name")).toHaveText("за всё время");
  });

  test("месяц открывает свою историю и закрывается «Скрыть»", async ({ cabinet }) => {
    const { page, openTab } = cabinet;
    await openTab("Аналитика");

    await expect(page.getByText("Нажмите на месяц, чтобы увидеть визиты")).toBeVisible();
    const title = monthTitle(PAST.slice(0, 7));
    const col = page.getByRole("button", { name: new RegExp(`^${title}`) });
    await col.click();
    await expect(col).toHaveAttribute("aria-pressed", "true");

    const history = page.locator(".an-month");
    await expect(history.locator(".an-month-title")).toHaveText(title);
    await expect(history.locator(".an-month-row").first()).toContainText("Анна");

    await history.getByRole("button", { name: "Скрыть" }).click();
    await expect(history).toBeHidden();
    await expect(col).toHaveAttribute("aria-pressed", "false");
  });

  test("постоянный клиент открывает карточку в «Клиентах»", async ({ cabinet }) => {
    const { page, openTab } = cabinet;
    await openTab("Аналитика");

    await page.locator(".an-top", { hasText: "Анна" }).click();

    await expect(page.getByRole("heading", { name: "Клиенты" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Все · 2" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('.client-row[data-expanded="true"]')).toContainText("Анна");
  });

  test("редко приходят: следующая запись, связь и «Записать»", async ({ cabinet }) => {
    const { page, openTab } = cabinet;
    await openTab("Аналитика");

    const row = page.locator(".an-rare", { hasText: "Вера" });
    await expect(row).toContainText("ещё не была");
    await expect(row).toContainText("Запись:");
    await expect(row.getByRole("link", { name: "Написать в WhatsApp" })).toHaveAttribute(
      "href",
      "https://wa.me/995555112233"
    );

    await row.getByRole("button", { name: "Записать" }).click();
    await expect(page.getByRole("dialog")).toContainText("Вера");
  });

  for (const width of [375, 393, 430]) {
    test(`пять вкладок без обрезки и без прокрутки вбок, ${width}px`, async ({ cabinet }) => {
      const { page, openTab } = cabinet;
      await page.setViewportSize({ width, height: 800 });
      await openTab("Аналитика");
      await expect(page.locator(".an-revenue")).toBeVisible();

      const clipped = await page.$$eval(".bottom-nav-label", (els) =>
        els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)
      );
      expect(clipped).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
