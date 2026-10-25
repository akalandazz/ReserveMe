import { expect, test } from "../support/fixtures.js";

// Несколько услуг в одной записи: клиент отмечает их на первом шаге,
// окно — одно, подряд, длина и цена — сумма, порядок — порядок прайса
// (services.sort), а не порядок нажатий. Сервер (guard_client_booking →
// services_total) берёт из заявки только id — подделка ведёт себя так же.

test.use({
  services: [
    [
      { id: "manicure", name: "Маникюр", price: 60, duration: 90, sort: 2, active: true },
      { id: "pedicure", name: "Педикюр", price: 80, duration: 90, sort: 1, active: true },
      { id: "brows", name: "Брови", price: 40, duration: 30, sort: 3, active: true },
      { id: "lashes", name: "Ресницы", price: 50, duration: 60, sort: 4, active: true },
      { id: "massage", name: "Массаж", price: 70, duration: 30, sort: 5, active: true },
    ],
    {},
  ],
});

/** Вместо чата с мастером (sendToMaster → window.open без Telegram) — счётчик. */
async function stubChat(page) {
  await page.evaluate(() => {
    window.__chats = 0;
    window.open = () => {
      window.__chats += 1;
      return null;
    };
  });
}

const service = (page, name) => page.getByRole("button", { name: new RegExp(name) });
const next = (page) => page.getByRole("button", { name: /^Далее/ });
const nothingPicked = (page) => page.getByRole("button", { name: "Выберите услугу" });

test("две услуги — одна заявка подряд, в порядке прайса", async ({ miniapp }) => {
  const { page, backend } = miniapp;
  await stubChat(page);
  await page.getByRole("button", { name: "Записаться" }).click();

  // Нажаты в обратном порядке — в заявку уйдут по прайсу: Педикюр, Маникюр.
  await service(page, "Маникюр").click();
  await service(page, "Педикюр").click();
  await expect(service(page, "Маникюр")).toHaveAttribute("aria-pressed", "true");
  await expect(next(page)).toHaveText("Далее · 2 услуги · 180 мин · 140 ₽");
  await next(page).click();

  // Второй открытый день — не сегодня: окна целиком с 10:00 до 19:00,
  // и последнее начало под 180 минут — 16:00 (под одну услугу было бы 17:30).
  await page.locator(".day-row:not([disabled])").nth(1).click();
  await expect(page.locator(".slot").last()).toHaveText("16:00");
  await page.locator(".slot").first().click();

  const summary = page.locator(".summary");
  await expect(summary).toContainText("Педикюр · 90 мин");
  await expect(summary).toContainText("Маникюр · 90 мин");
  await expect(summary).toContainText("180 мин");
  await expect(summary).toContainText("140 ₽");
  const preview = page.locator(".msg-preview");
  await expect(preview).toContainText("Услуги:");
  await expect(preview).toContainText("• Педикюр — 90 мин");
  await expect(preview).toContainText("• Маникюр — 90 мин");

  await page.getByRole("button", { name: "Отправить заявку" }).click();
  await expect.poll(() => page.evaluate(() => window.__chats)).toBe(1);

  // От услуг уходят одни id, по прайсу; итог считает сервер.
  const sent = backend.inserts.find((i) => i.table === "bookings").body;
  expect(sent.services).toEqual([{ id: "pedicure" }, { id: "manicure" }]);
  expect(backend.tables.bookings[0]).toMatchObject({
    service_id: "pedicure",
    service_name: "Педикюр + Маникюр",
    duration: 180,
    price: 140,
  });

  await page.getByRole("button", { name: /Мои записи/ }).click();
  await expect(page.locator(".book-card")).toContainText("Педикюр + Маникюр");
});

test("повторное нажатие снимает услугу, больше четырёх — нельзя", async ({ miniapp }) => {
  const { page } = miniapp;
  await page.getByRole("button", { name: "Записаться" }).click();
  await expect(nothingPicked(page)).toBeDisabled();

  await service(page, "Брови").click();
  await expect(next(page)).toBeEnabled();
  await service(page, "Брови").click();
  await expect(service(page, "Брови")).toHaveAttribute("aria-pressed", "false");
  await expect(nothingPicked(page)).toBeDisabled();

  for (const name of ["Маникюр", "Педикюр", "Брови", "Ресницы"]) await service(page, name).click();
  await service(page, "Массаж").click();
  await expect(page.getByRole("alert")).toContainText("не больше 4 услуг");
  await expect(service(page, "Массаж")).toHaveAttribute("aria-pressed", "false");
  await expect(next(page)).toHaveText(/^Далее · 4 услуги/);
});
