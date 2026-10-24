import { expect, test } from "../support/fixtures.js";

// «Настройки» → «Услуги и цены» (ServicesSection): порядок — тоже данные.
// Стрелки и перетаскивание меняют черновик, «Сохранить» пишет sort = индекс + 1,
// клиент видит тот же порядок (order by sort, id).

const SERVICES = [
  { id: "manicure", name: "Маникюр", price: 60, duration: 90, sort: 1, active: true },
  { id: "pedicure", name: "Педикюр", price: 80, duration: 90, sort: 2, active: true },
  { id: "brows", name: "Брови", price: 40, duration: 30, sort: 3, active: true },
];

test.use({ services: [SERVICES, {}] });

/** Названия услуг в редакторе сверху вниз. */
const names = (page) =>
  page.locator(".service-row").evaluateAll((rows) => rows.map((r) => r.querySelector("input").value));

const row = (page, id) => page.getByTestId(`service-row-${id}`);
const serviceWrites = (backend) => backend.changes.filter((c) => c.table === "services");

test.beforeEach(async ({ cabinet }) => {
  await cabinet.openTab("Настройки");
  await expect.poll(() => names(cabinet.page)).toEqual(["Маникюр", "Педикюр", "Брови"]);
});

test("стрелки меняют порядок, крайние выключены", async ({ cabinet }) => {
  const { page } = cabinet;
  await expect(row(page, "manicure").getByRole("button", { name: "Выше" })).toBeDisabled();
  await expect(row(page, "brows").getByRole("button", { name: "Ниже" })).toBeDisabled();

  await row(page, "manicure").getByRole("button", { name: "Ниже" }).click();
  await expect.poll(() => names(page)).toEqual(["Педикюр", "Маникюр", "Брови"]);

  await row(page, "brows").getByRole("button", { name: "Выше" }).click();
  await expect.poll(() => names(page)).toEqual(["Педикюр", "Брови", "Маникюр"]);

  await expect(row(page, "pedicure").getByRole("button", { name: "Выше" })).toBeDisabled();
  await expect(row(page, "manicure").getByRole("button", { name: "Ниже" })).toBeDisabled();
  await expect(row(page, "manicure").getByRole("button", { name: "Выше" })).toBeEnabled();
});

test("«Отменить» возвращает прежний порядок и ничего не пишет", async ({ cabinet }) => {
  const { page, backend } = cabinet;
  await row(page, "brows").getByRole("button", { name: "Выше" }).click();
  await expect(page.getByText("Есть несохранённые изменения.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить" }).first()).toBeEnabled();

  await page.getByRole("button", { name: "Отменить" }).first().click();
  await expect.poll(() => names(page)).toEqual(["Маникюр", "Педикюр", "Брови"]);
  await expect(page.getByText("Есть несохранённые изменения.")).toBeHidden();
  expect(serviceWrites(backend)).toEqual([]);
});

test("«Сохранить» пишет sort, порядок переживает перезагрузку", async ({ cabinet }) => {
  const { page, backend, openTab } = cabinet;
  await row(page, "brows").getByRole("button", { name: "Выше" }).click();
  await row(page, "brows").getByRole("button", { name: "Выше" }).click();
  await expect.poll(() => names(page)).toEqual(["Брови", "Маникюр", "Педикюр"]);

  await page.getByRole("button", { name: "Сохранить" }).first().click();
  await expect(page.getByText("Услуги сохранены")).toBeVisible();

  const writes = serviceWrites(backend);
  expect(writes.map((w) => [w.id, w.body.sort]).sort()).toEqual([
    ["brows", 1],
    ["manicure", 2],
    ["pedicure", 3],
  ]);
  // Поля, которые не менялись, уходят как были — emoji/note/active не трогаем.
  expect(writes.find((w) => w.id === "brows").body).toEqual({
    name: "Брови",
    price: 40,
    duration: 30,
    sort: 1,
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Расписание" })).toBeVisible();
  await openTab("Настройки");
  await expect.poll(() => names(page)).toEqual(["Брови", "Маникюр", "Педикюр"]);
  await expect(page.getByText("Есть несохранённые изменения.")).toBeHidden();
});

test("поля по-прежнему правятся, перетаскивает только ручка", async ({ cabinet }) => {
  const { page } = cabinet;
  const name = row(page, "pedicure").getByLabel("Название услуги");
  await name.fill("Педикюр SPA");
  await expect(name).toHaveValue("Педикюр SPA");
  await name.selectText();
  expect(await name.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe(
    "Педикюр SPA"
  );

  await expect(row(page, "pedicure")).not.toHaveAttribute("draggable", "true");
  const grip = row(page, "pedicure").locator(".service-grip");
  await expect(grip).toHaveAttribute("draggable", "true");
  await expect(grip).toHaveAttribute("title", "Перетащите, чтобы изменить порядок");
});

test.describe("перетаскивание (десктоп)", () => {
  test.use({ hasTouch: false, isMobile: false });

  test("вниз и вверх — на место целевой строки", async ({ cabinet }) => {
    const { page } = cabinet;
    await row(page, "manicure").locator(".service-grip").dragTo(row(page, "brows"));
    await expect.poll(() => names(page)).toEqual(["Педикюр", "Брови", "Маникюр"]);
    await expect(page.getByText("Есть несохранённые изменения.")).toBeVisible();
    // dragend снял подсветку.
    await expect(page.locator(".service-row.drop-target")).toHaveCount(0);

    await row(page, "manicure").locator(".service-grip").dragTo(row(page, "pedicure"));
    await expect.poll(() => names(page)).toEqual(["Маникюр", "Педикюр", "Брови"]);
    await expect(page.locator(".service-row.drop-target")).toHaveCount(0);
  });
});
