import { CLIENT, initDataFor, installFakeSupabase } from "../support/fake-supabase.js";
import { expect, test, withTelegram } from "../support/fixtures.js";

// Мини-апп целиком — только для вошедших (App.jsx → AuthScreen). Вход —
// через Telegram: src/supabase.js шлёт initData в Edge Function
// telegram-auth (здесь — поддельную, fake-supabase.js), формы нет.
// Здесь не фикстура miniapp: она входит заранее, а нам нужен сам вход.
// Подпись initData проверяют e2e/unit и e2e/integration — не здесь.

test("в обычном браузере — «Откройте в Telegram», без запросов входа", async ({ page, backend }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Откройте в Telegram" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Записаться" })).toHaveCount(0);
  expect(backend.authCalls).toEqual([]);
  expect(backend.rpcs).toEqual([]);
});

test("вход по initData: в функцию уходит только initData", async ({ page, backend }) => {
  await withTelegram(page, CLIENT);
  await page.goto("/");

  await expect(page.getByText(`Привет, ${CLIENT.firstName}!`)).toBeVisible();
  await expect(page.getByText(`Вы вошли как ${CLIENT.firstName}`)).toBeVisible();
  // Ни роли, ни id, ни имени из initDataUnsafe — только подписанная строка.
  expect(backend.authCalls).toEqual([{ initData: initDataFor(CLIENT.telegramId) }]);
});

test("первый вход нового пользователя — роль user, не мастер", async ({ page, backend }) => {
  const newcomer = { telegramId: 3003, firstName: "Новый", username: "" };
  await withTelegram(page, newcomer);
  await page.goto("/");

  await expect(page.getByText("Привет, Новый!")).toBeVisible();
  const created = backend.users.find((u) => u.telegramId === 3003);
  expect(backend.tables.profiles.find((p) => p.id === created.id)).toMatchObject({
    telegram_id: 3003,
    role: "user",
  });
});

test("сессия не лежит в localStorage", async ({ page, backend }) => {
  await withTelegram(page, CLIENT);
  await page.goto("/");
  await expect(page.getByText(`Привет, ${CLIENT.firstName}!`)).toBeVisible();

  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain("access_token");
  expect(stored).not.toContain("e2e-refresh-");
  expect(backend.authCalls).toHaveLength(1);
});

test("устаревший initData — понятная ошибка и «Повторить»", async ({ page, backend }) => {
  await withTelegram(page, CLIENT, { initData: "e2e:expired" });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Не удалось войти" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Данные входа устарели");
  await page.getByRole("button", { name: "Повторить" }).click();
  await expect.poll(() => backend.authCalls.length).toBe(2);
  await expect(page.getByRole("heading", { name: "Не удалось войти" })).toBeVisible();
});

test("неверный initData — без входа", async ({ page, backend }) => {
  await withTelegram(page, CLIENT, { initData: "forged" });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Telegram не подтвердил вход");
  await expect(page.getByRole("button", { name: "Записаться" })).toHaveCount(0);
  expect(backend.sessions.size).toBe(0);
});

test("выход отзывает сессию этого устройства; «Войти снова» — новый вход", async ({ page, backend }) => {
  await withTelegram(page, CLIENT);
  await page.goto("/");
  await expect(page.getByText(`Привет, ${CLIENT.firstName}!`)).toBeVisible();

  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("heading", { name: "Вы вышли" })).toBeVisible();
  // scope=local — только эта сессия; на других устройствах вход остаётся.
  expect(backend.logouts).toHaveLength(1);
  expect(backend.logouts[0].scope).toBe("local");
  expect(backend.sessions.size).toBe(0);

  await page.getByRole("button", { name: "Войти снова" }).click();
  await expect(page.getByText(`Привет, ${CLIENT.firstName}!`)).toBeVisible();
  expect(backend.authCalls).toHaveLength(2);
});

test("два устройства одного Telegram-аккаунта — один пользователь, две сессии", async ({
  browser,
}) => {
  const phone = await browser.newPage();
  const desktop = await browser.newPage();
  // Общая «база» на оба устройства: обработчик подделки читает поля
  // своего state, поэтому второму подставляем таблицы первого.
  const state = await installFakeSupabase(phone);
  const second = await installFakeSupabase(desktop);
  Object.assign(second, {
    tables: state.tables,
    users: state.users,
    sessions: state.sessions,
    nextId: 5000, // свои id сессий, без пересечений с первым
  });

  for (const p of [phone, desktop]) {
    await withTelegram(p, CLIENT);
    await p.goto("/");
    await expect(p.getByText(`Привет, ${CLIENT.firstName}!`)).toBeVisible();
  }
  expect(state.tables.profiles.filter((p) => p.telegram_id === CLIENT.telegramId)).toHaveLength(1);
  expect(state.users.filter((u) => u.telegramId === CLIENT.telegramId)).toHaveLength(1);
  expect(state.sessions.size).toBe(2);
  expect(new Set(state.sessions.values())).toEqual(new Set([CLIENT.id]));

  // Выход с телефона не трогает десктоп.
  await phone.getByRole("button", { name: "Выйти" }).click();
  await expect(phone.getByRole("heading", { name: "Вы вышли" })).toBeVisible();
  expect(state.sessions.size).toBe(1);
  await expect(desktop.getByText(`Привет, ${CLIENT.firstName}!`)).toBeVisible();

  expect([...state.unhandled, ...second.unhandled]).toEqual([]);
  await phone.close();
  await desktop.close();
});
