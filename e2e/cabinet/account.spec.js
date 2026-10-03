import { MASTER } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// «Настройки» показывают, под каким аккаунтом открыт кабинет, — рядом с «Выйти».

test("в «Настройках» видно имя вошедшего мастера из Telegram", async ({ cabinet }) => {
  const { page, openTab } = cabinet;
  await openTab("Настройки");

  await expect(page.getByText("Аккаунт", { exact: true })).toBeVisible();
  await expect(page.locator(".account-email")).toHaveText(MASTER.firstName);
  await expect(page.getByRole("button", { name: "Выйти" })).toBeVisible();
});

test("выход из кабинета отзывает сессию и прячет данные", async ({ cabinet }) => {
  const { page, backend, openTab } = cabinet;
  await openTab("Настройки");
  await page.getByRole("button", { name: "Выйти" }).click();

  await expect(page.getByRole("heading", { name: "Вы вышли" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Расписание" })).toHaveCount(0);
  expect(backend.logouts.map((l) => l.scope)).toEqual(["local"]);
});
