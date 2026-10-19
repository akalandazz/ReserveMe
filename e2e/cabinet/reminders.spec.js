import { expect, test } from "../support/fixtures.js";

// «Настройки» → «Напоминания»: за сколько часов бот напоминает клиенту
// (settings.reminder_hours, 0 — выключено). Шаги — из списка, сохраняется
// сразу, как график работы.

test("мастер меняет время напоминания и выключает его", async ({ cabinet }) => {
  const { page, backend, openTab } = cabinet;
  await openTab("Настройки");

  const value = page.getByTestId("reminder-hours");
  await expect(value).toHaveText("24 ч");

  await page.getByRole("button", { name: "Напоминать раньше" }).click();
  await expect(value).toHaveText("48 ч");
  await expect.poll(() => backend.tables.settings[0].reminder_hours).toBe(48);

  // 48 → 24 → 12 → 6 → 3 → 2 → выкл.
  const later = page.getByRole("button", { name: "Напоминать позже" });
  for (const label of ["24 ч", "12 ч", "6 ч", "3 ч", "2 ч", "Выкл."]) {
    await later.click();
    await expect(value).toHaveText(label);
  }
  await expect.poll(() => backend.tables.settings[0].reminder_hours).toBe(0);
  // Ниже нуля шага нет — лишний запрос не уходит.
  const writes = backend.changes.filter((c) => c.table === "settings").length;
  await later.click();
  await expect(value).toHaveText("Выкл.");
  expect(backend.changes.filter((c) => c.table === "settings").length).toBe(writes);
});
