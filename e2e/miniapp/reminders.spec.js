import { CLIENT } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Напоминания о записи от бота: переключатель в «Мои записи» пишет
// profiles.reminders через set_reminders() (писать в profiles напрямую
// клиенту нельзя). Включение сначала просит у Telegram разрешение боту
// писать (requestWriteAccess, 6.9+); отказ — не включаем.

const openMyBookings = (page) => page.getByRole("button", { name: /Мои записи/ }).click();
const reminderSwitch = (page) => page.getByRole("switch", { name: "Напоминать о записи" });
const setRemindersCalls = (backend) =>
  backend.rpcs.filter((r) => r.name === "set_reminders").map((r) => r.body);

test.describe("Мини-апп: напоминания о записи", () => {
  test("выключить и включить — через set_reminders", async ({ miniapp }) => {
    const { page, backend } = miniapp;
    await openMyBookings(page);
    const sw = reminderSwitch(page);
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Бот пришлёт сообщение за сутки до подтверждённой записи")).toBeVisible();

    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("Напоминания выключены.")).toBeVisible();

    // Без SDK (браузер) спросить разрешение нечем — включаем, а дойдёт ли,
    // решит ответ Telegram на первую отправку.
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Напомним о записи в Telegram.")).toBeVisible();

    expect(setRemindersCalls(backend)).toEqual([{ p_enabled: false }, { p_enabled: true }]);
    expect(backend.tables.profiles.find((p) => p.id === CLIENT.id).reminders).toBe(true);
  });

  test("отказ в разрешении боту — не включаем", async ({ miniapp }) => {
    const { page, backend } = miniapp;
    await openMyBookings(page);
    const sw = reminderSwitch(page);
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");

    // Telegram 6.9+, бот ещё не может писать, клиент жмёт «Отмена».
    await page.evaluate(() => {
      const w = window.Telegram.WebApp;
      w.isVersionAtLeast = () => true;
      w.requestWriteAccess = (cb) => {
        window.__writeAccessAsked = true;
        cb(false);
      };
    });
    await sw.click();
    await expect(page.getByText("Без разрешения бот не сможет прислать напоминание.")).toBeVisible();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => window.__writeAccessAsked)).toBe(true);
    expect(setRemindersCalls(backend)).toEqual([{ p_enabled: false }]);
  });

  test("разрешение уже есть — не спрашиваем", async ({ miniapp }) => {
    const { page } = miniapp;
    await openMyBookings(page);
    const sw = reminderSwitch(page);
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");

    await page.evaluate(() => {
      const w = window.Telegram.WebApp;
      w.isVersionAtLeast = () => true;
      w.initDataUnsafe.user.allows_write_to_pm = true;
      w.requestWriteAccess = () => {
        window.__writeAccessAsked = true;
      };
    });
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => window.__writeAccessAsked ?? false)).toBe(false);
  });

  test("салон не напоминает (reminder_hours = 0) — переключателя нет", async ({ miniapp }) => {
    const { page, backend } = miniapp;
    backend.tables.settings[0].reminder_hours = 0;
    // Смена экрана перечитывает контент (refreshAll в App.jsx) — ждём ответ.
    const reread = page.waitForResponse((r) => r.url().includes("/rest/v1/settings"));
    await openMyBookings(page);
    await reread;
    await expect(page.getByText("Пока нет записей")).toBeVisible();
    await expect(reminderSwitch(page)).toBeHidden();
  });
});
