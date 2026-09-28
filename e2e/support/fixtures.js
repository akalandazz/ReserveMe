import { test as base, expect } from "@playwright/test";
import { MASTER, installFakeSupabase } from "./fake-supabase.js";

/**
 * clients — строки client_stats, которые уже лежат в «базе» до входа
 *   (test.use({ clients: [...] })).
 * backend — поддельный Supabase (fake-supabase.js), поставленный до
 *   первого запроса страницы. После теста проверяет, что кабинет не
 *   сходил ни в один адрес, которого подделка не знает.
 * cabinet — кабинет мастера (admin.html) после входа по паролю.
 */
export const test = base.extend({
  clients: [[], { option: true }],

  backend: async ({ page, clients }, use) => {
    const state = await installFakeSupabase(page);
    state.tables.client_stats.push(...clients);
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
});

export { expect };
