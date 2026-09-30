import { test as base, expect } from "@playwright/test";
import { CLIENT, MASTER, installFakeSupabase, sessionFor } from "./fake-supabase.js";

/**
 * clients — строки client_stats, которые уже лежат в «базе» до входа
 *   (test.use({ clients: [...] })).
 * bookings — строки bookings в «базе» (bookingRow из fake-supabase.js).
 * backend — поддельный Supabase (fake-supabase.js), поставленный до
 *   первого запроса страницы. После теста проверяет, что приложение не
 *   сходило ни в один адрес, которого подделка не знает.
 * cabinet — кабинет мастера (admin.html) после входа по паролю;
 *   openedChats() — чаты с клиентами, которые он открыл (window.open).
 * miniapp — мини-апп клиента (index.html) на главной, уже вошедший как
 *   CLIENT: сессия auth-js лежит в localStorage до загрузки. Экран входа
 *   проверяет e2e/miniapp/auth.spec.js — без этой фикстуры.
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
    // Без Telegram openChatWith (src/telegram.js) открывает t.me во
    // вкладке — запоминаем адреса вместо настоящего окна.
    await page.addInitScript(() => {
      window.__openedChats = [];
      window.open = (url) => {
        window.__openedChats.push(String(url));
        return null;
      };
    });
    await page.goto("/admin.html");
    await page.getByLabel("E-mail").fill(MASTER.email);
    await page.getByLabel("Пароль").fill(MASTER.password);
    await page.getByRole("button", { name: "Войти" }).click();
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
    await page.addInitScript(
      ({ session }) => {
        // Только при первой загрузке — перезагрузка в тесте видит то, что
        // приложение само сохранило. Ключ — AUTH_STORAGE_KEY мини-аппа в
        // src/supabase.js.
        if (localStorage.getItem("vs_sb_client_v1") === null) {
          localStorage.setItem("vs_sb_client_v1", JSON.stringify(session));
        }
      },
      { session: sessionFor(CLIENT) }
    );
    await page.goto("/");
    await expect(page.getByText("Добро пожаловать!")).toBeVisible();
    await use({ page, backend });
  },
});

export { expect };
