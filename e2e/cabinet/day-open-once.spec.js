import { expect, test } from "../support/fixtures.js";

// Выходной по графику (в fake-supabase — воскресенье, working_hours[0] = null)
// открывается на одну дату (days_open), а недельный график не меняется:
// раньше «Сделать рабочим днём» открывало сразу все воскресенья.

/** Сколько дней до ближайшего воскресенья (1–7) — не сегодня. */
const SUNDAY = (7 - new Date().getDay()) % 7 || 7;

function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function shiftDays(page, n) {
  for (let i = 0; i < n; i++) {
    await page.getByRole("button", { name: "Следующий день" }).click();
  }
}

const panel = (page) => page.locator(".day-panel");

test.describe("Кабинет: разово открытый выходной", () => {
  test("«Открыть только этот день» открывает одну дату, а не все воскресенья", async ({
    cabinet,
  }) => {
    const { page, backend } = cabinet;
    await shiftDays(page, SUNDAY);
    await expect(panel(page)).toContainText("Выходной по графику");

    await page.getByRole("button", { name: "Открыть только этот день" }).click();

    await expect(panel(page)).toContainText("10:00–19:00 · открыт разово");
    expect(backend.inserts.filter((i) => i.table === "days_open").map((i) => i.body)).toEqual([
      { day: dayKey(SUNDAY), hours: { from: "10:00", to: "19:00" } },
    ]);
    // Недельный график не тронут.
    expect(backend.changes.filter((c) => c.table === "settings")).toEqual([]);

    // Следующее воскресенье — по-прежнему выходной.
    await shiftDays(page, 7);
    await expect(panel(page)).toContainText("Выходной по графику");
  });

  test("часы разово открытого дня правятся ±, «Закрыть день» возвращает выходной", async ({
    cabinet,
  }) => {
    const { page, backend } = cabinet;
    await shiftDays(page, SUNDAY);
    await page.getByRole("button", { name: "Открыть только этот день" }).click();
    await expect(panel(page)).toContainText("открыт разово");

    await page.getByRole("button", { name: "Конец позже" }).click();
    await expect(panel(page)).toContainText("10:00–19:30 · открыт разово");
    expect(backend.tables.days_open).toEqual([
      { day: dayKey(SUNDAY), hours: { from: "10:00", to: "19:30" } },
    ]);

    await page.getByRole("button", { name: "Закрыть день" }).click();
    await expect(panel(page)).toContainText("Выходной по графику");
    expect(backend.tables.days_open).toEqual([]);
    // Не «закрыт вручную»: в days_off ничего не пишется.
    expect(backend.inserts.filter((i) => i.table === "days_off")).toEqual([]);
  });

  test("«Сделать рабочими все воскресенья» меняет недельный график", async ({ cabinet }) => {
    const { page, backend } = cabinet;
    await shiftDays(page, SUNDAY);

    await page.getByRole("button", { name: "Сделать рабочими все воскресенья" }).click();

    await expect(panel(page)).toContainText("10:00–19:00 · записей: 0");
    const patch = backend.changes.find((c) => c.table === "settings");
    expect(patch.body.working_hours[0]).toEqual({ from: "10:00", to: "19:00" });
    expect(backend.tables.days_open).toEqual([]);
  });
});
