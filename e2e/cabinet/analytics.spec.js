import { currentMonthRange, monthTitle, rangeLabel } from "../../src/admin/analytics.js";
import { bookingRow, clientRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Вкладка «Аналитика» (AnalyticsSection.jsx): числа считает сервер —
// /api/analytics (подделка гоняет тот же _shared/analytics.js); визит —
// подтверждённая прошедшая запись.

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

  test("график по месяцам — только для чтения", async ({ cabinet }) => {
    const { page, openTab } = cabinet;
    await openTab("Аналитика");

    // Одна картинка с описанием для скринридера, без кнопок и истории месяца.
    const chart = page.getByRole("img", { name: /^По месяцам:/ });
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("aria-label", new RegExp(monthTitle(PAST.slice(0, 7))));
    await expect(chart.locator(".an-col")).toHaveCount(6);
    await expect(chart.getByRole("button")).toHaveCount(0);
    await expect(page.getByText("Нажмите на месяц, чтобы увидеть визиты")).toHaveCount(0);

    await chart.locator(".an-col").last().click();
    await expect(page.locator(".an-month")).toHaveCount(0);
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

  test("числа приходят с сервера: запрос с периодом и JWT мастера", async ({ cabinet }) => {
    const { page, openTab, backend: state } = cabinet;
    await openTab("Аналитика");
    await expect(page.locator(".an-card")).toBeVisible();

    const calls = state.rpcs.filter((r) => r.name === "api/analytics");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1).body).toEqual(currentMonthRange());

    await pickRange(page, PAST, PAST);
    await expect.poll(() => state.rpcs.filter((r) => r.name === "api/analytics").at(-1).body).toEqual({
      from: PAST,
      to: PAST,
    });
  });

  test("сервер не ответил — ошибка и «Повторить»", async ({ cabinet }) => {
    const { page, openTab, backend: state } = cabinet;
    state.failAnalytics = "Не удалось загрузить аналитику";
    await openTab("Аналитика");

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Не удалось загрузить аналитику");
    await expect(page.locator(".an-card")).toHaveCount(0);

    state.failAnalytics = null;
    await alert.getByRole("button", { name: "Повторить" }).click();
    await expect(page.locator(".an-card")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
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
