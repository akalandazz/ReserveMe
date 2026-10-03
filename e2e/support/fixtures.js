import { test as base, expect } from "@playwright/test";
import { CLIENT, MASTER, installFakeSupabase, telegramStub } from "./fake-supabase.js";

/**
 * Открыть страницу «из Telegram»: window.Telegram.WebApp с initData этого
 * пользователя появляется до первого скрипта страницы (и после reload).
 * Настоящий telegram-web-app.js подделка обрывает (fake-supabase.js).
 */
export async function withTelegram(page, user, opts) {
  await page.addInitScript((webApp) => {
    window.Telegram = { WebApp: { ...webApp, ready() {}, expand() {} } };
  }, telegramStub(user, opts));
}

/**
 * clients — строки client_stats, которые уже лежат в «базе» до входа
 *   (test.use({ clients: [...] })).
 * bookings — строки bookings в «базе» (bookingRow из fake-supabase.js).
 * backend — поддельный Supabase (fake-supabase.js), поставленный до
 *   первого запроса страницы. После теста проверяет, что приложение не
 *   сходило ни в один адрес, которого подделка не знает.
 * cabinet — кабинет мастера (admin.html), открытый из Telegram мастером:
 *   вход по initData проходит сам. openedChats() — чаты с клиентами,
 *   которые он открыл (window.open).
 * miniapp — мини-апп клиента (index.html) на главной, открытый из Telegram
 *   как CLIENT. Экран входа проверяет e2e/miniapp/auth.spec.js — без этой
 *   фикстуры.
 * fakeClock — поставить page.clock до загрузки мини-аппа или кабинета,
 *   чтобы тест мог промотать таймеры (опрос занятости в BookingScreen,
 *   опрос записей в кабинете — pollAdminData).
 */
export const test = base.extend({
  clients: [[], { option: true }],
  bookings: [[], { option: true }],
  fakeClock: [false, { option: true }],

  backend: async ({ page, clients, bookings }, use) => {
    const state = await installFakeSupabase(page);
    state.tables.client_stats.push(...clients);
    state.tables.bookings.push(...bookings);
    await use(state);
    expect(state.unhandled, "запросы мимо поддельного Supabase").toEqual([]);
  },

  cabinet: async ({ page, backend, fakeClock }, use) => {
    if (fakeClock) await page.clock.install();
    // Без openTelegramLink openChatWith (src/telegram.js) открывает t.me во
    // вкладке — запоминаем адреса вместо настоящего окна.
    await page.addInitScript(() => {
      window.__openedChats = [];
      window.open = (url) => {
        window.__openedChats.push(String(url));
        return null;
      };
    });
    await withTelegram(page, MASTER);
    await page.goto("/admin.html");
    await expect(page.getByRole("heading", { name: "Расписание" })).toBeVisible();
    await use({
      page,
      backend,
      openTab: (label) => page.getByRole("navigation").getByRole("button", { name: label }).click(),
      // Чаты, которые кабинет открыл клиентам: [{ username, text }].
      openedChats: () =>
        page.evaluate(() =>
          window.__openedChats.map((u) => {
            const url = new URL(u);
            return { username: url.pathname.slice(1), text: url.searchParams.get("text") };
          })
        ),
    });
  },

  miniapp: async ({ page, backend, fakeClock }, use) => {
    if (fakeClock) await page.clock.install();
    await withTelegram(page, CLIENT);
    await page.goto("/");
    await expect(page.getByText(`Привет, ${CLIENT.firstName}!`)).toBeVisible();
    await use({ page, backend });
  },
});

export { expect };
