import { bookingRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Своя цена записи: на шаге проверки «Стоимость» — поле, по умолчанию
// сумма по прайсу (у правки с теми же услугами — согласованная цена).
// Другая цена уходит в p_price create/update_master_booking, та же — null
// (цену считает сервер). Сообщение клиенту — с той ценой, что в поле.

function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const lastRpc = (backend, name) => backend.rpcs.filter((r) => r.name === name).at(-1)?.body;

test.use({
  services: [
    [
      { id: "manicure", name: "Маникюр", price: 60, duration: 90, sort: 1, active: true },
      { id: "brows", name: "Брови", price: 40, duration: 30, sort: 2, active: true },
    ],
    {},
  ],
});

test.describe("новая запись", () => {
  async function toConfirm({ page }) {
    await page.getByRole("button", { name: "Записать" }).first().click();
    await page.locator(".bk-new-card").click();
    await page.getByPlaceholder("Имя *").fill("Вера");
    await page.getByRole("button", { name: "Дальше — услуга" }).click();
    await page.locator(".bk-service", { hasText: "Маникюр" }).click();
    await page.getByRole("button", { name: /^Дальше · 90 мин/ }).click();
    await page.locator(".bk-day:not([disabled])").first().click();
    await page.locator(".bk-slot").first().click();
    return page.getByLabel("Стоимость");
  }

  test("своя цена уходит в create_master_booking и в сообщение", async ({ cabinet }) => {
    const { page, backend } = cabinet;
    const price = await toConfirm(cabinet);
    await expect(price).toHaveValue("60");

    await price.fill("45");
    await expect(page.locator(".bk-sum-note")).toHaveText(/по прайсу 60\s₽/);
    await expect(page.locator(".bk-msg")).toContainText(/45\s₽/);

    await page.getByRole("button", { name: "Записать клиента" }).click();
    await expect.poll(() => lastRpc(backend, "create_master_booking")?.p_price).toBe(45);
  });

  test("«Вернуть» — снова по прайсу, p_price не уходит", async ({ cabinet }) => {
    const { page, backend } = cabinet;
    const price = await toConfirm(cabinet);
    await price.fill("45");
    await page.getByRole("button", { name: "Вернуть" }).click();
    await expect(price).toHaveValue("60");
    await expect(page.locator(".bk-sum-note")).toHaveCount(0);

    await page.getByRole("button", { name: "Записать клиента" }).click();
    await expect.poll(() => lastRpc(backend, "create_master_booking")).toBeTruthy();
    expect(lastRpc(backend, "create_master_booking").p_price).toBeNull();
  });

  test("пустая цена — не сохраняется, ошибка в листе", async ({ cabinet }) => {
    const { page, backend } = cabinet;
    const price = await toConfirm(cabinet);
    await price.fill("");
    await expect(price).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Записать клиента" }).click();
    await expect(page.locator(".sheet-error")).toContainText("Цена — целое число");
    expect(lastRpc(backend, "create_master_booking")).toBeUndefined();
  });
});

test.describe("правка заявки", () => {
  test.use({
    bookings: [
      bookingRow(1, {
        day: dayKey(3),
        duration: 120,
        price: 100,
        service_name: "Маникюр + Брови",
        services: [
          { id: "manicure", name: "Маникюр", duration: 90, price: 60 },
          { id: "brows", name: "Брови", duration: 30, price: 40 },
        ],
      }),
    ],
  });

  test("другая цена — «Есть изменения», прежняя зачёркнута, p_price в update", async ({ cabinet }) => {
    const { page, backend, openTab } = cabinet;
    await openTab("Заявки");
    await page.getByRole("button", { name: "Изменить" }).click();

    const price = page.getByLabel("Стоимость");
    await expect(price).toHaveValue("100");
    await expect(page.locator(".bk-changed")).toHaveCount(0);

    await price.fill("80");
    await expect(page.locator(".bk-changed")).toBeVisible();
    const row = page.locator(".bk-sum-row", { has: price });
    await expect(row.locator(".bk-sum-old")).toHaveText(/100\s₽/);
    await expect(page.locator(".bk-msg")).toContainText(/80\s₽/);

    await page.getByRole("button", { name: "Сохранить и подтвердить" }).click();
    await expect.poll(() => lastRpc(backend, "update_master_booking")?.p_price).toBe(80);
  });

  test("цена не тронута — p_price null, согласованная остаётся", async ({ cabinet }) => {
    const { page, backend, openTab } = cabinet;
    await openTab("Заявки");
    await page.getByRole("button", { name: "Изменить" }).click();
    await page.getByRole("button", { name: "Подтвердить запись" }).click();
    await expect.poll(() => lastRpc(backend, "update_master_booking")).toBeTruthy();
    expect(lastRpc(backend, "update_master_booking").p_price).toBeNull();
  });
});
