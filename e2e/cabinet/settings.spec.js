import { expect, test } from "../support/fixtures.js";

// «Настройки» → профиль, адрес, правила записи (SalonSection): у каждой
// группы свой черновик и своё «Сохранить», и в PATCH уходят только
// изменённые поля этой группы.

const settingsWrites = (backend) => backend.changes.filter((c) => c.table === "settings");

test("мастер меняет профиль — уходят только изменённые поля", async ({ cabinet }) => {
  const { page, backend, openTab } = cabinet;
  await openTab("Настройки");

  const profile = page.getByTestId("settings-profile");
  await expect(profile.getByLabel("Имя")).toHaveValue("Владислава");
  await expect(profile.getByLabel("Логин Telegram")).toHaveValue("vseees");

  await profile.getByLabel("Имя").fill("  Влада ");
  await profile.getByLabel("Логин Telegram").fill("@vlada_nails");
  await profile.getByRole("button", { name: "Сохранить" }).click();

  await expect(page.getByText("Профиль сохранён")).toBeVisible();
  await expect.poll(() => settingsWrites(backend).length).toBe(1);
  expect(settingsWrites(backend)[0].body).toEqual({
    master_name: "Влада",
    master_username: "vlada_nails",
  });
  // Стор перечитан — поле показывает сохранённое, черновика нет.
  await expect(profile.getByLabel("Логин Telegram")).toHaveValue("vlada_nails");
  await expect(profile.getByRole("button", { name: "Отменить" })).toBeHidden();
});

test("неверный логин и ссылка не уходят на сервер", async ({ cabinet }) => {
  const { page, backend, openTab } = cabinet;
  await openTab("Настройки");

  const profile = page.getByTestId("settings-profile");
  await profile.getByLabel("Логин Telegram").fill("влада");
  await profile.getByRole("button", { name: "Сохранить" }).click();
  await expect(profile.getByText("Логин Telegram — латиница")).toBeVisible();

  const location = page.getByTestId("settings-location");
  await location.getByLabel("Ссылка на карту").fill("javascript:alert(1)");
  await location.getByRole("button", { name: "Сохранить" }).click();
  await expect(location.getByText("должна начинаться с https://")).toBeVisible();

  expect(settingsWrites(backend)).toHaveLength(0);
});

test("пустой логин предупреждает, «Отменить» возвращает сохранённое", async ({ cabinet }) => {
  const { page, backend, openTab } = cabinet;
  await openTab("Настройки");

  const profile = page.getByTestId("settings-profile");
  await profile.getByLabel("Логин Telegram").fill("");
  await expect(profile.getByText("Без логина клиенты не смогут")).toBeVisible();

  await profile.getByRole("button", { name: "Отменить" }).click();
  await expect(profile.getByLabel("Логин Telegram")).toHaveValue("vseees");
  await expect(profile.getByText("Без логина клиенты не смогут")).toBeHidden();
  expect(settingsWrites(backend)).toHaveLength(0);
});

test("мастер меняет адрес и правила записи", async ({ cabinet }) => {
  const { page, backend, openTab } = cabinet;
  await openTab("Настройки");

  const location = page.getByTestId("settings-location");
  await location.getByLabel("Адрес").fill("ул. Руставели, 12");
  await location.getByLabel("Ссылка на карту").fill("https://yandex.ru/maps/-/abc");
  await location.getByRole("button", { name: "Сохранить" }).click();
  await expect.poll(() => settingsWrites(backend).length).toBe(1);
  expect(settingsWrites(backend)[0].body).toEqual({
    address: "ул. Руставели, 12",
    map_url: "https://yandex.ru/maps/-/abc",
  });

  const rules = page.getByTestId("settings-rules");
  await rules.getByLabel("Шаг окошек").selectOption("15");
  await expect(rules.getByText("Закрытые окошки, которые не попадут")).toBeVisible();
  await rules.getByLabel("Запись вперёд, дней").fill("30");
  await rules.getByLabel("Запись на сегодня — не позже чем").selectOption("60");
  await rules.getByRole("button", { name: "Сохранить" }).click();

  await expect.poll(() => settingsWrites(backend).length).toBe(2);
  expect(settingsWrites(backend)[1].body).toEqual({
    slot_step_minutes: 15,
    booking_days_ahead: 30,
    min_lead_minutes: 60,
  });
  expect(backend.tables.settings[0].slot_step_minutes).toBe(15);
});

test("запись вперёд вне 1–60 дней не сохраняется", async ({ cabinet }) => {
  const { page, backend, openTab } = cabinet;
  await openTab("Настройки");

  const rules = page.getByTestId("settings-rules");
  await rules.getByLabel("Запись вперёд, дней").fill("90");
  await rules.getByRole("button", { name: "Сохранить" }).click();
  await expect(rules.getByText("Запись вперёд — от 1 до 60 дней")).toBeVisible();
  expect(settingsWrites(backend)).toHaveLength(0);
});
