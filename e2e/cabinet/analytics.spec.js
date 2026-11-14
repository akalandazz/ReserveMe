import { currentMonthRange, monthTitle, rangeLabel } from "../../src/admin/analytics.js";
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

const monthIndex = (key) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;

/**
 * Выбрать период в календаре: открыть его кнопкой периода, долистать до
 * месяца каждого дня, нажать начало и конец, «Применить». Календарь
 * открывается на месяце текущего начала периода (по умолчанию — этот).
 */
async function pickRange(page, from, to) {
  await page.getByRole("button", { name: /^Период:/ }).click();
  const picker = page.locator(".an-range");
  let shown = monthIndex(dayKey(0));
  for (const key of [from, to]) {
    const target = monthIndex(key);
    for (; shown > target; shown--) await picker.getByRole("button", { name: "Предыдущий месяц" }).click();
    for (; shown < target; shown++) await picker.getByRole("button", { name: "Следующий месяц" }).click();
    await picker
      .locator(".rdp-day-btn:not(.is-outside)", { hasText: new RegExp(`^${Number(key.slice(8))}$`) })
      .click();
  }
  await picker.getByRole("button", { name: "Применить" }).click();
  await expect(picker).toBeHidden();
}

test.describe("Кабинет: аналитика", () => {
  test("по умолчанию — этот месяц, кнопка периода без быстрого выбора", async ({ cabinet }) => {
    const { page, openTab } = cabinet;
    await openTab("Аналитика");

    const month = rangeLabel(currentMonthRange());
    await expect(page.getByRole("heading", { name: "Аналитика" })).toBeVisible();
    await expect(page.locator(".header-name")).toHaveText(`за ${month}`);
    await expect(page.getByRole("button", { name: `Период: ${month}. Выбрать даты` })).toBeVisible();
    await expect(page.getByRole("button", { name: "Прошлый месяц" })).toHaveCount(0);
  });

  test("заработано, ожидается и плитки — только подтверждённые", async ({ cabinet }) => {
    const { page, openTab } = cabinet;
    await openTab("Аналитика");
    await pickRange(page, dayKey(-4), dayKey(5));
    await expect(page.locator(".header-name")).toHaveText(
      `за ${rangeLabel({ from: dayKey(-4), to: dayKey(5) })}`
    );

    const figures = page.locator(".an-figure");
    await expect(figures.nth(0)).toContainText(/Заработано150\s₽2 визита/);
    await expect(figures.nth(1)).toContainText(/Ожидается500\s₽1 запись впереди/);
    await expect(page.locator(".an-total")).toContainText(/650\s₽/);
    const tiles = page.locator(".an-tiles .stat-tile");
    await expect(tiles.nth(0)).toContainText("2Визитов");
    await expect(tiles.nth(1)).toContainText("1Впереди");
    await expect(tiles.nth(2)).toContainText(/75\s₽/);
  });

  test("один день, затем «Сбросить» — снова этот месяц", async ({ cabinet }) => {
    const { page, openTab } = cabinet;
    await openTab("Аналитика");
    await pickRange(page, PAST, PAST);

    const one = rangeLabel({ from: PAST, to: PAST });
    await expect(page.locator(".header-name")).toHaveText(`за ${one}`);
    await expect(page.locator(".an-figure").nth(0)).toContainText(/60\s₽1 визит/);
    await expect(page.locator(".an-figure").nth(1)).toContainText(/0\s₽/);

    await page.getByRole("button", { name: /^Период:/ }).click();
    await page.locator(".an-range").getByRole("button", { name: "Сбросить" }).click();
    await expect(page.locator(".header-name")).toHaveText(`за ${rangeLabel(currentMonthRange())}`);
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
    await expect(history.locator('.an-month-row[data-upcoming="false"]').first()).toContainText("Анна");
    // Будущая подтверждённая запись того же месяца — с пометкой «впереди».
    if (dayKey(5).slice(0, 7) === PAST.slice(0, 7)) {
      await expect(history.locator('.an-month-row[data-upcoming="true"]')).toContainText("Веравпереди");
    }

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
      await expect(page.locator(".an-card")).toBeVisible();
      await page.getByRole("button", { name: /^Период:/ }).click();
      await expect(page.locator(".an-range")).toBeVisible();

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
