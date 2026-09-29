import { clientRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// «Клиенты» → «Новый клиент»: лист BookingSheet в режиме { kind: "client" },
// сохранение — createClient() в src/admin/api.js, затем кабинет раскрывает
// нового клиента в режиме «Все» (clientFocus в AdminApp.jsx).

async function openNewClientSheet({ page, openTab }) {
  await openTab("Клиенты");
  await page.getByRole("button", { name: "Новый клиент" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Новый клиент" })).toBeVisible();
  return sheet;
}

test.describe("Кабинет: новый клиент", () => {
  test("заводит клиента и раскрывает его карточку", async ({ cabinet }) => {
    const { page, backend } = cabinet;
    const sheet = await openNewClientSheet(cabinet);

    await sheet.getByLabel("Имя", { exact: true }).fill("Анна Тестова");
    await sheet.getByLabel("Телефон").fill("  +995 555 12 34 56 ");
    await sheet.getByLabel("Telegram").fill("@anna_nails");
    // Заголовок листа следует за именем.
    await expect(sheet.getByRole("heading", { name: "Анна Тестова" })).toBeVisible();

    await sheet.getByRole("button", { name: "Добавить клиента" }).click();

    await expect(page.getByText("Анна Тестова добавлена в базу.")).toBeVisible();
    await expect(sheet).toBeHidden();

    // В базу уходит нормализованное: без пробелов по краям и без «@»;
    // лист клиента канал не показывает — и не отправляет.
    expect(backend.inserts).toHaveLength(1);
    const [insert] = backend.inserts;
    expect(insert.body).toEqual({
      name: "Анна Тестова",
      phone: "+995 555 12 34 56",
      telegram_username: "anna_nails",
    });
    // Пишет вошедший мастер, а не аноним (RLS проверяет is_master()).
    expect(insert.headers.authorization).toMatch(/^Bearer .+\..+\..+/);

    // Кабинет переключился на «Все» и раскрыл нового клиента.
    await expect(page.getByRole("button", { name: "Все", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByText("1 всего")).toBeVisible();
    const row = page.locator(".client-row", { hasText: "Анна Тестова" });
    await expect(row).toHaveAttribute("data-expanded", "true");
    await expect(row).toContainText("@anna_nails");
    await expect(row).toContainText("ещё не была");
    await expect(row).toContainText("Телефон: +995 555 12 34 56");
    await expect(row).toContainText("Предстоящие записи · 0");
    await expect(row.getByRole("link", { name: "Написать в Telegram" })).toHaveAttribute(
      "href",
      "https://t.me/anna_nails"
    );
  });

  test("без имени не сохраняет", async ({ cabinet }) => {
    const sheet = await openNewClientSheet(cabinet);

    await sheet.getByLabel("Телефон").fill("+995 555 00 00 00");
    const save = sheet.getByRole("button", { name: "Добавить клиента" });
    await expect(save).toHaveAttribute("data-ready", "false");
    await save.click();

    await expect(sheet).toContainText("Укажите имя клиента.");
    await expect(sheet).toBeVisible();
    expect(cabinet.backend.inserts).toHaveLength(0);
  });

  test.describe("клиент с этим Telegram уже есть", () => {
    test.use({ clients: [clientRow(1, { name: "Мария", telegram_username: "maria_tg" })] });

    test("ошибка в листе, после правки сохраняется", async ({ cabinet }) => {
      const { page, backend } = cabinet;
      const sheet = await openNewClientSheet(cabinet);

      await sheet.getByLabel("Имя", { exact: true }).fill("Мария Вторая");
      await sheet.getByLabel("Telegram").fill("@maria_tg");
      await sheet.getByRole("button", { name: "Добавить клиента" }).click();

      // Ошибка — строкой в листе (тост кабинета ушёл бы под затемнение),
      // лист открыт, введённое на месте.
      await expect(sheet).toContainText("Клиент с таким Telegram уже есть.");
      await expect(sheet.getByLabel("Имя", { exact: true })).toHaveValue("Мария Вторая");
      expect(backend.tables.client_stats).toHaveLength(1);

      await sheet.getByLabel("Telegram").fill("");
      await sheet.getByRole("button", { name: "Добавить клиента" }).click();

      await expect(page.getByText("Мария Вторая добавлена в базу.")).toBeVisible();
      await expect(sheet).toBeHidden();
      await expect(page.getByText("2 всего")).toBeVisible();
      expect(backend.inserts.map((i) => i.body.telegram_username)).toEqual(["maria_tg", ""]);
    });
  });
});
