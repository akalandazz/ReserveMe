import { expect, test } from "../support/fixtures.js";

// Выходной, открытый мастером на одну дату (days_open), клиент видит
// рабочим, а другое воскресенье в окне записи — по-прежнему выходным.

/** Сколько дней до ближайшего воскресенья (1–7) — не сегодня. */
const SUNDAY = (7 - new Date().getDay()) % 7 || 7;
// Другое воскресенье в окне из 14 дней: через неделю, а если сегодня
// воскресенье (SUNDAY = 7, +7 вышло бы за окно) — сегодняшнее.
const OTHER_SUNDAY = SUNDAY === 7 ? 0 : SUNDAY + 7;

function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test("мини-апп: разово открытое воскресенье доступно для записи, другое — нет", async ({
  miniapp,
}) => {
  const { page, backend } = miniapp;
  // Контент перечитывается на смене экрана — «Записаться» уже увидит строку.
  backend.tables.days_open.push({ day: dayKey(SUNDAY), hours: { from: "12:00", to: "15:00" } });

  await page.getByRole("button", { name: "Записаться" }).click();
  await page.getByRole("button", { name: /Маникюр/ }).click();

  const rows = page.locator(".day-row");
  // 12:00–15:00, услуга 90 мин, шаг 30: 12:00, 12:30, 13:00, 13:30.
  await expect(rows.nth(SUNDAY)).toContainText("свободно окошек: 4");
  await expect(rows.nth(SUNDAY)).toBeEnabled();
  await expect(rows.nth(OTHER_SUNDAY)).toContainText("выходной");
  await expect(rows.nth(OTHER_SUNDAY)).toBeDisabled();

  await rows.nth(SUNDAY).click();
  await expect(page.locator(".slot")).toHaveText(["12:00", "12:30", "13:00", "13:30"]);
});
