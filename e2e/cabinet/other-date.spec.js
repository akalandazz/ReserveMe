import { bookingRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// «Другая дата» на шаге «Выберите день»: дата за пределами списка из трёх
// недель. На iOS пикер шлёт change на каждый поворот колеса — лист не
// должен уходить на время по первой же тронутой дате, только по кнопке.

function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.use({ bookings: [bookingRow(1, { day: dayKey(3) })] });

test("другая дата — переход только по кнопке, на последнюю выбранную", async ({ cabinet }) => {
  const { page, backend, openTab } = cabinet;
  await openTab("Заявки");
  await page.getByRole("button", { name: "Изменить" }).click();
  await page.locator(".bk-summary").getByRole("button", { name: "Перенести" }).click();

  const input = page.getByLabel("Другая дата");
  // Две «прокрутки» пикера подряд: первая дата — промежуточная.
  await input.fill(dayKey(30));
  await input.fill(dayKey(40));
  await expect(page.locator(".bk-days")).toBeVisible();
  expect(backend.rpcs.filter((r) => r.name === "free_slots")).toHaveLength(0);

  await page.getByRole("button", { name: /^Показать время/ }).click();
  await expect
    .poll(() => backend.rpcs.filter((r) => r.name === "free_slots").map((r) => r.body.p_day))
    .toEqual([dayKey(40)]);
});
