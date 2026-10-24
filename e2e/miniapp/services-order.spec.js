import { expect, test } from "../support/fixtures.js";

// Порядок услуг у клиента — services.sort, который пишет кабинет
// (e2e/cabinet/services-order.spec.js): и в «Услуги и цены», и в выборе услуги.

test.use({
  services: [
    [
      { id: "manicure", name: "Маникюр", price: 60, duration: 90, sort: 3, active: true },
      { id: "pedicure", name: "Педикюр", price: 80, duration: 90, sort: 1, active: true },
      { id: "brows", name: "Брови", price: 40, duration: 30, sort: 2, active: true },
    ],
    {},
  ],
});

const ORDER = [/Педикюр/, /Брови/, /Маникюр/];

test("«Услуги и цены» — в порядке sort", async ({ miniapp }) => {
  const { page } = miniapp;
  await page.getByRole("button", { name: /Услуги и цены/ }).click();
  await expect(page.locator(".list-row")).toHaveText(ORDER);
});

test("выбор услуги в записи — в порядке sort", async ({ miniapp }) => {
  const { page } = miniapp;
  await page.getByRole("button", { name: "Записаться" }).click();
  await expect(page.getByRole("button", { name: /Педикюр|Брови|Маникюр/ })).toHaveText(ORDER);
});
