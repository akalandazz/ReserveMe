import { MASTER } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// «Настройки» показывают, под каким аккаунтом открыт кабинет, — рядом с «Выйти».

test("в «Настройках» виден e-mail вошедшего мастера", async ({ cabinet }) => {
  const { page, openTab } = cabinet;
  await openTab("Настройки");

  await expect(page.getByText("Аккаунт", { exact: true })).toBeVisible();
  await expect(page.getByText(MASTER.email, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Выйти" })).toBeVisible();
});
