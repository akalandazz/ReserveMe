import { CLIENT } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Мини-апп целиком — только для вошедших (App.jsx → AuthScreen). Роль
// 'user' новому аккаунту ставит само приложение (ensureProfile в
// src/supabase.js) — триггера на auth.users нет.
// Здесь не фикстура miniapp: она входит заранее, а нам нужен гость.

test("гость видит только форму входа — без контента и без заявок", async ({ page, backend }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Записаться" })).toHaveCount(0);
  expect(backend.rpcs).toEqual([]);
});

test("регистрация даёт роль user и открывает главную", async ({ page, backend }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Нет аккаунта? Зарегистрироваться" }).click();
  await page.getByLabel("E-mail").fill("new@e2e.test");
  await page.getByLabel("Пароль", { exact: true }).fill("secret-1");
  await page.getByLabel("Повторите пароль").fill("secret-1");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();

  await expect(page.getByText("Добро пожаловать!")).toBeVisible();
  await expect(page.getByText("Вы вошли как new@e2e.test")).toBeVisible();
  const created = backend.users.find((u) => u.email === "new@e2e.test");
  await expect.poll(() => backend.profileWrites).toContainEqual({ id: created.id, role: "user" });
});

test("несовпадающие пароли не уходят на сервер", async ({ page, backend }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Нет аккаунта? Зарегистрироваться" }).click();
  await page.getByLabel("E-mail").fill("new@e2e.test");
  await page.getByLabel("Пароль", { exact: true }).fill("secret-1");
  await page.getByLabel("Повторите пароль").fill("secret-2");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();

  await expect(page.getByRole("alert")).toHaveText("Пароли не совпадают");
  expect(backend.users.some((u) => u.email === "new@e2e.test")).toBe(false);
});

test("занятый e-mail — понятная ошибка", async ({ page, backend }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Нет аккаунта? Зарегистрироваться" }).click();
  await page.getByLabel("E-mail").fill(CLIENT.email);
  await page.getByLabel("Пароль", { exact: true }).fill("secret-1");
  await page.getByLabel("Повторите пароль").fill("secret-1");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();

  await expect(page.getByRole("alert")).toHaveText("Этот e-mail уже зарегистрирован — войдите");
  expect(backend.users.filter((u) => u.email === CLIENT.email)).toHaveLength(1);
});

// backend — во всех тестах: без него подделка не стоит, и запросы уходят в сеть.
test("неверный пароль — ошибка по-русски, остаёмся на входе", async ({ page, backend }) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(CLIENT.email);
  await page.getByLabel("Пароль", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Войти" }).click();

  await expect(page.getByRole("alert")).toHaveText("Неверный e-mail или пароль");
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  // Без сессии строку роли не заводим.
  expect(backend.profileWrites).toEqual([]);
});

test("вход и выход", async ({ page, backend }) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(CLIENT.email);
  await page.getByLabel("Пароль", { exact: true }).fill(CLIENT.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText("Добро пожаловать!")).toBeVisible();
  // Строка роли заводится и при входе — upsert с ignoreDuplicates.
  await expect.poll(() => backend.profileWrites).toContainEqual({ id: CLIENT.id, role: "user" });

  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
});
