import { CLIENT } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Клиенты теперь регистрируются сами, и вошедший — ещё не мастер:
// кабинет пускает только роль 'master' (profiles, is_master() в schema.sql).
// Данные кабинета RLS клиенту не отдаст, но и запрашивать их незачем.

test("клиент в кабинете видит «Нет доступа», данные не грузятся", async ({ page, backend }) => {
  const bookingReads = [];
  page.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === "/rest/v1/bookings") bookingReads.push(r.url());
  });

  await page.goto("/admin.html");
  await page.getByLabel("E-mail").fill(CLIENT.email);
  await page.getByLabel("Пароль").fill(CLIENT.password);
  await page.getByRole("button", { name: "Войти" }).click();

  await expect(page.getByRole("heading", { name: "Нет доступа" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Расписание" })).toHaveCount(0);
  expect(bookingReads).toEqual([]);

  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("button", { name: "Войти" })).toBeVisible();
  // Строку роли кабинет заводит тоже — клиенту, как и в мини-аппе, 'user'.
  expect(backend.tables.profiles).toContainEqual({ id: CLIENT.id, role: "user" });
});
