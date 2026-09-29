import { test as base, expect } from "@playwright/test";
import { MASTER, installFakeSupabase } from "./fake-supabase.js";

/**
 * clients — строки client_stats, которые уже лежат в «базе» до входа
 *   (test.use({ clients: [...] })).
 * bookings — строки bookings в «базе» (bookingRow из fake-supabase.js).
 * localBookings — записи клиента на устройстве (src/storage.js): без
 *   Telegram они живут в localStorage под vs_bookings_v1.
 * backend — поддельный Supabase (fake-supabase.js), поставленный до
 *   первого запроса страницы. После теста проверяет, что приложение не
 *   сходило ни в один адрес, которого подделка не знает.
 * cabinet — кабинет мастера (admin.html) после входа по паролю.
 * miniapp — мини-апп клиента (index.html) на главной.
 */
export const test = base.extend({
  clients: [[], { option: true }],
  bookings: [[], { option: true }],
  localBookings: [[], { option: true }],

  backend: async ({ page, clients, bookings }, use) => {
    const state = await installFakeSupabase(page);
    state.tables.client_stats.push(...clients);
    state.tables.bookings.push(...bookings);
    await use(state);
    expect(state.unhandled, "запросы мимо поддельного Supabase").toEqual([]);
  },

  cabinet: async ({ page, backend }, use) => {
    await page.goto("/admin.html");
    await page.getByLabel("E-mail").fill(MASTER.email);
    await page.getByLabel("Пароль").fill(MASTER.password);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page.getByRole("heading", { name: "Расписание" })).toBeVisible();
    await use({
      page,
      backend,
      openTab: (label) => page.getByRole("navigation").getByRole("button", { name: label }).click(),
    });
  },

  miniapp: async ({ page, backend, localBookings }, use) => {
    await page.addInitScript((list) => {
      // Только при первой загрузке — перезагрузка в тесте видит то, что
      // приложение само сохранило.
      if (localStorage.getItem("vs_bookings_v1") === null) {
        localStorage.setItem("vs_bookings_v1", JSON.stringify(list));
      }
    }, localBookings);
    await page.goto("/");
    await expect(page.getByText("Добро пожаловать!")).toBeVisible();
    await use({
      page,
      backend,
      stored: () => page.evaluate(() => JSON.parse(localStorage.getItem("vs_bookings_v1") || "[]")),
    });
  },
});

export { expect };
