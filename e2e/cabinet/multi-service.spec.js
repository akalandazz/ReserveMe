import { bookingRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Заявка из нескольких услуг в листе «Изменить»: услуги отмечаются, а не
// выбираются одна, «Дальше» проверяет, влезают ли они в уже выбранное
// время (free_slots), и update_master_booking получает весь набор.

function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.use({
  services: [
    [
      { id: "manicure", name: "Маникюр", price: 60, duration: 90, sort: 1, active: true },
      { id: "brows", name: "Брови", price: 40, duration: 30, sort: 2, active: true },
    ],
    {},
  ],
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

test("заявка из двух услуг — снять одну и подтвердить", async ({ cabinet }) => {
  const { page, backend, openTab } = cabinet;
  await openTab("Заявки");
  await expect(page.getByText("Маникюр + Брови")).toBeVisible();
  await page.getByRole("button", { name: "Изменить" }).click();

  const summary = page.locator(".bk-summary");
  await expect(summary).toContainText("Услуги");
  await expect(summary).toContainText("Маникюр + Брови");
  await summary.getByRole("button", { name: "Изменить" }).click();

  const option = (name) => page.locator(".bk-service", { hasText: name });
  await expect(option("Маникюр")).toHaveAttribute("aria-pressed", "true");
  await expect(option("Брови")).toHaveAttribute("aria-pressed", "true");
  await option("Брови").click();
  await expect(option("Брови")).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: /^Дальше · 90 мин/ }).click();

  // Время то же (10:00) и влезает — сразу проверка: услуга уже одна,
  // прежний набор — зачёркнутым рядом.
  const servicesRow = summary.locator(".bk-sum-row").first();
  await expect(servicesRow.locator(".bk-sum-v")).toHaveText("Маникюр");
  await expect(servicesRow.locator(".bk-sum-old")).toHaveText("Маникюр + Брови");
  expect(backend.rpcs).toContainEqual(
    expect.objectContaining({
      name: "free_slots",
      body: expect.objectContaining({ p_service_ids: ["manicure"] }),
    })
  );
  await page.getByRole("button", { name: "Сохранить и подтвердить" }).click();
  await expect
    .poll(() => backend.rpcs.find((r) => r.name === "update_master_booking")?.body.p_service_ids)
    .toEqual(["manicure"]);
});
