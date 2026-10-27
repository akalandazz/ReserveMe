import { bookingRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Шаг «Выберите день»: список из трёх недель и «Показать ещё 3 недели»
// вместо <input type="date"> — его пикер в Telegram на iOS закрывается
// сам, и мастер не могла записать дальше трёх недель.

function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const rpcs = (backend, name) => backend.rpcs.filter((r) => r.name === name);

async function openDayStep({ page, openTab }) {
  await openTab("Заявки");
  await page.getByRole("button", { name: "Изменить" }).click();
  await page.locator(".bk-summary").getByRole("button", { name: "Перенести" }).click();
}

test.describe("ближняя запись", () => {
  test.use({ bookings: [bookingRow(1, { day: dayKey(3) })] });

  test("«Показать ещё» добавляет три недели, их день открывает время", async ({ cabinet }) => {
    const { page, backend } = cabinet;
    await openDayStep(cabinet);
    const days = page.locator(".bk-day");
    await expect(days).toHaveCount(21);
    await expect(page.getByRole("button", { name: "Другая дата" })).toHaveCount(0);

    await page.getByRole("button", { name: "Показать ещё 3 недели" }).click();
    await expect(days).toHaveCount(42);
    await expect
      .poll(() => rpcs(backend, "free_slot_counts").map((r) => r.body.p_from))
      .toContain(dayKey(21));

    // Последний открытый день — уже из второго куска (неделя повторяется).
    await page.locator(".bk-day:not([disabled])").last().click();
    await expect.poll(() => rpcs(backend, "free_slots").length).toBe(1);
    expect(rpcs(backend, "free_slots")[0].body.p_day >= dayKey(21)).toBe(true);
  });
});

test.describe("дальняя запись", () => {
  test.use({ bookings: [bookingRow(1, { day: dayKey(30) })] });

  test("перенос записи дальше трёх недель — список сразу до её дня", async ({ cabinet }) => {
    const { page } = cabinet;
    await openDayStep(cabinet);
    await expect(page.locator(".bk-day")).toHaveCount(42);
    await expect(page.locator(".bk-day", { hasText: "текущий день" })).toHaveCount(1);
  });
});
