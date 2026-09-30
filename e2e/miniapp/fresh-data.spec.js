import { SUPABASE_URL } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Клиент всегда видит свежие данные: контент и занятость перечитываются
// на каждой смене экрана и опросом, пока экран открыт (App.jsx), а перед
// отправкой заявки BookingScreen сверяет
// экран с базой (src/content.js → refreshAll).

/** Ключ "ГГГГ-ММ-ДД" через daysAhead дней. */
function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Занимает время hhmm на все дни окна записи — какой бы день ни выбрал тест. */
function occupy(backend, hhmm) {
  for (let i = 0; i <= 15; i++) {
    backend.tables.busy_slots.push({ day: dayKey(i), start_min: toMinutes(hhmm), duration: 90 });
  }
}

/** Главная → услуга → первый день со свободным временем → первое окошко. Возвращает время. */
async function reachConfirm(page) {
  await page.getByRole("button", { name: "Записаться" }).click();
  await page.getByRole("button", { name: /Маникюр/ }).click();
  await page.locator(".day-row:not([disabled])").first().click();
  const slot = page.locator(".slot").first();
  const time = (await slot.textContent()).trim();
  await slot.click();
  await expect(page.getByRole("heading", { name: "Подтвердите заявку" })).toBeVisible();
  return time;
}

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

const bookingInserts = (backend) => backend.inserts.filter((i) => i.table === "bookings");

test.describe("Мини-апп: свежие данные", () => {
  test("цена, поменянная в базе, видна на следующем же экране", async ({ miniapp }) => {
    const { page, backend } = miniapp;
    backend.tables.services[0].price = 75;

    await page.getByRole("button", { name: /Услуги и цены/ }).click();
    await expect(page.locator(".list-row")).toContainText("75 ₾");
  });

  test("цена поменялась перед отправкой — заявка не уходит, пока клиент не увидит новую", async ({
    miniapp,
  }) => {
    const { page, backend } = miniapp;
    await stubChat(page);
    await reachConfirm(page);
    await expect(page.locator(".summary")).toContainText("60 ₾");

    backend.tables.services[0].price = 75;
    await page.getByRole("button", { name: "Отправить заявку" }).click();

    await expect(page.getByRole("alert")).toContainText("данные обновились");
    await expect(page.locator(".summary")).toContainText("75 ₾");
    await expect(page.locator(".msg-preview")).toContainText("75");
    expect(bookingInserts(backend)).toHaveLength(0);
    expect(await page.evaluate(() => window.__chats)).toBe(0);

    // Клиент увидел новую цену — второе нажатие отправляет.
    await page.getByRole("button", { name: "Отправить заявку" }).click();
    await expect.poll(() => bookingInserts(backend).length).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__chats)).toBe(1);
    expect(backend.tables.bookings).toHaveLength(1);
    expect(backend.tables.bookings[0]).toMatchObject({ price: 75, status: "new" });
  });

  test("время заняли перед отправкой — заявка не уходит, клиент видит предупреждение", async ({
    miniapp,
  }) => {
    const { page, backend } = miniapp;
    await stubChat(page);
    const time = await reachConfirm(page);

    occupy(backend, time);
    await page.getByRole("button", { name: "Отправить заявку" }).click();

    await expect(page.getByRole("alert")).toContainText("данные обновились");
    await expect(page.getByText("Это время только что стало занято")).toBeVisible();
    expect(bookingInserts(backend)).toHaveLength(0);
    expect(await page.evaluate(() => window.__chats)).toBe(0);
  });

  test.describe("опрос", () => {
    test.use({ fakeClock: true });

    test("цена, поменянная в базе, видна без перехода по экранам", async ({ miniapp }) => {
      const { page, backend } = miniapp;
      await page.getByRole("button", { name: /Услуги и цены/ }).click();
      await expect(page.locator(".list-row")).toContainText("60 ₾");

      backend.tables.services[0].price = 75;
      await page.clock.fastForward(20_000);
      await expect(page.locator(".list-row")).toContainText("75 ₾");
    });

    test("окошко, которое заняли, пока клиент смотрит на сетку, пропадает само", async ({
      miniapp,
    }) => {
      const { page, backend } = miniapp;
      await page.getByRole("button", { name: "Записаться" }).click();
      await page.getByRole("button", { name: /Маникюр/ }).click();
      await page.locator(".day-row:not([disabled])").first().click();

      const first = page.locator(".slot").first();
      const time = (await first.textContent()).trim();
      occupy(backend, time);

      await page.clock.fastForward(30_000);
      await expect(page.locator(".slot", { hasText: new RegExp(`^${time}$`) })).toHaveCount(0);
    });
  });

  test("база не отвечает — на экране сохранённые данные и предупреждение", async ({ miniapp }) => {
    const { page } = miniapp;
    await expect(page.locator(".stale-note")).toHaveCount(0);

    // Поверх подделки: теперь любой запрос к PostgREST — 500.
    await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
      route.fulfill({
        status: 500,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify({ message: "e2e: down" }),
      })
    );

    await page.getByRole("button", { name: /Услуги и цены/ }).click();
    await expect(page.locator(".stale-note")).toContainText("могли устареть");
    await expect(page.locator(".list-row")).toContainText("Маникюр");
  });
});
