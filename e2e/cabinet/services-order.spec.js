import { expect, test } from "../support/fixtures.js";

// «Настройки» → «Услуги и цены» (ServicesSection): порядок — тоже данные.
// Перетаскивание за ручку меняет черновик, «Сохранить» пишет sort = индекс + 1,
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

test("у строки только ручка — стрелок нет", async ({ cabinet }) => {
  const { page } = cabinet;
  await expect(page.locator(".service-grip")).toHaveCount(3);
  await expect(page.getByRole("button", { name: /^(Выше|Ниже)$/ })).toHaveCount(0);
});

test("«Отменить» возвращает прежний порядок и ничего не пишет", async ({ cabinet }) => {
  const { page, backend } = cabinet;
  await touchDrag(page, "brows", "pedicure");
  await expect.poll(() => names(page)).toEqual(["Маникюр", "Брови", "Педикюр"]);
  await expect(page.getByText("Есть несохранённые изменения.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить" }).first()).toBeEnabled();

  await page.getByRole("button", { name: "Отменить" }).first().click();
  await expect.poll(() => names(page)).toEqual(["Маникюр", "Педикюр", "Брови"]);
  await expect(page.getByText("Есть несохранённые изменения.")).toBeHidden();
  expect(serviceWrites(backend)).toEqual([]);
});

test("«Сохранить» пишет sort, порядок переживает перезагрузку", async ({ cabinet }) => {
  const { page, backend, openTab } = cabinet;
  await touchDrag(page, "brows", "manicure");
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

  // Протянуть мышью по полю — выделение текста, а не перенос строки.
  // Сначала снять выделение: тянуть уже выделенный текст — это перенос текста.
  await name.press("End");
  const box = await name.boundingBox();
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height * 3, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => names(page)).toEqual(["Маникюр", "Педикюр SPA", "Брови"]);
  expect(await name.evaluate((el) => el.selectionEnd - el.selectionStart)).toBeGreaterThan(0);
  await expect(page.locator(".service-row.dragging")).toHaveCount(0);

  const grip = row(page, "pedicure").locator(".service-grip");
  await expect(grip).toHaveAttribute("title", "Перетащите, чтобы изменить порядок");
});

const center = async (locator) => {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** Мышью: ручка строки from → середина строки to, с промежуточными шагами. */
async function mouseDrag(page, from, to) {
  const a = await center(row(page, from).locator(".service-grip"));
  const b = await center(row(page, to));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await expect(page.locator(".service-row.drop-target")).toHaveCount(1);
  await page.mouse.up();
}

/** Пальцем — настоящие touch-события Chromium (CDP), как на телефоне. */
async function touchDrag(page, from, to) {
  const a = await center(row(page, from).locator(".service-grip"));
  const b = await center(row(page, to));
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, p) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: p ? [{ x: Math.round(p.x), y: Math.round(p.y) }] : [],
    });
  await touch("touchStart", a);
  for (let i = 1; i <= 12; i++) {
    await touch("touchMove", { x: a.x, y: a.y + ((b.y - a.y) * i) / 12 });
  }
  await expect(page.locator(".service-row.drop-target")).toHaveCount(1);
  await touch("touchEnd");
  await cdp.detach();
}

test("пальцем на телефоне — вниз и вверх на место целевой строки", async ({ cabinet }) => {
  const { page } = cabinet;
  await touchDrag(page, "manicure", "brows");
  await expect.poll(() => names(page)).toEqual(["Педикюр", "Брови", "Маникюр"]);
  await expect(page.getByText("Есть несохранённые изменения.")).toBeVisible();
  await expect(page.locator(".service-row.drop-target, .service-row.dragging")).toHaveCount(0);

  await touchDrag(page, "manicure", "pedicure");
  await expect.poll(() => names(page)).toEqual(["Маникюр", "Педикюр", "Брови"]);
});

test.describe("перетаскивание (десктоп)", () => {
  test.use({ hasTouch: false, isMobile: false });

  test("вниз и вверх — на место целевой строки", async ({ cabinet }) => {
    const { page } = cabinet;
    await mouseDrag(page, "manicure", "brows");
    await expect.poll(() => names(page)).toEqual(["Педикюр", "Брови", "Маникюр"]);
    await expect(page.getByText("Есть несохранённые изменения.")).toBeVisible();
    // После отпускания подсветки нет.
    await expect(page.locator(".service-row.drop-target, .service-row.dragging")).toHaveCount(0);

    await mouseDrag(page, "manicure", "pedicure");
    await expect.poll(() => names(page)).toEqual(["Маникюр", "Педикюр", "Брови"]);
  });
});
