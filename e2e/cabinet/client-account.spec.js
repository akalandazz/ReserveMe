import { CLIENT } from "../support/fake-supabase.js";
import { expect, test, withTelegram } from "../support/fixtures.js";

// Кабинет пускает только роль 'master' (profiles, is_master() в schema.sql).
// Клиент, открывший кабинет из Telegram, входит — это его аккаунт, — но
// данные кабинета RLS ему не отдаст, и запрашивать их незачем.

test("клиент в кабинете видит «Нет доступа», данные не грузятся", async ({ page, backend }) => {
  const bookingReads = [];
  page.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === "/rest/v1/bookings") bookingReads.push(r.url());
  });

  await withTelegram(page, CLIENT);
  await page.goto("/admin.html");

  await expect(page.getByRole("heading", { name: "Нет доступа" })).toBeVisible();
  await expect(page.getByText(`${CLIENT.firstName} — не аккаунт мастера`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Расписание" })).toHaveCount(0);
  expect(bookingReads).toEqual([]);
  // Роль при входе не изменилась.
  expect(backend.tables.profiles.find((p) => p.id === CLIENT.id).role).toBe("user");

  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("heading", { name: "Вы вышли" })).toBeVisible();
});

test("в обычном браузере кабинет просит открыть его в Telegram", async ({ page, backend }) => {
  await page.goto("/admin.html");
  await expect(page.getByText("Кабинет открывается только в Telegram")).toBeVisible();
  expect(backend.authCalls).toEqual([]);
});
