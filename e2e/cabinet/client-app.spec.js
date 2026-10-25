import { CLIENT, bookingRow, clientRow } from "../support/fake-supabase.js";
import { expect, test } from "../support/fixtures.js";

// Карточка клиента и приложение («Клиенты» → карточка, ClientsSection.jsx):
// записи карточки клиент видит в «Мои записи», только когда она привязана
// к его аккаунту (client_stats.in_app). «Пригласить в приложение» —
// Edge Function api/invite: клиенту, который уже в приложении, бот
// пишет сам; остальным кабинет открывает чат со ссылкой на бота, и бот
// присылает приглашение после «Запустить». Сами кнопки «Принять» /
// «Отклонить» в боте — e2e/integration/client-invites.spec.js.

function dayKey(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const DAY = dayKey(3);

async function openCard({ page, openTab }, name) {
  await openTab("Клиенты");
  await page.getByRole("button", { name: "Все", exact: true }).click();
  const row = page.locator(".client-row", { hasText: name });
  await row.locator(".client-row-head").click();
  await expect(row).toHaveAttribute("data-expanded", "true");
  return row;
}

test.describe("Кабинет: клиента нет в приложении — ссылка на бота", () => {
  test.use({
    clients: [clientRow(7, { name: "Вероника", telegram_username: "veronika_k" })],
    bookings: [
      bookingRow(70, { day: DAY, client_id: 7, client_name: "Вероника", status: "ok", source: "master" }),
    ],
  });

  test("«Пригласить» создаёт код и открывает чат со ссылкой на бота", async ({ cabinet }) => {
    const { page, backend, openedChats } = cabinet;
    const row = await openCard(cabinet, "Вероника");
    await expect(row).toContainText("Приложение: нет в приложении");
    await expect(row).toContainText("Откроется чат с клиентом и ссылкой на бота");

    await row.getByRole("button", { name: "Пригласить в приложение" }).click();

    await expect(page.getByText("Приглашение готово")).toBeVisible();
    expect(backend.rpcs.filter((r) => r.name === "api/invite").map((r) => r.body)).toEqual([
      { client_id: 7 },
    ]);
    const { code } = backend.tables.client_invites[0];

    const chats = await openedChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].username).toBe("veronika_k");
    expect(chats[0].text).toContain(`https://t.me/vseees_bot?start=c_${code}`);
    expect(chats[0].text).toContain("нажмите «Запустить»");
    expect(chats[0].text).toContain("Здравствуйте, Вероника!");
    expect(chats[0].text).toContain("Маникюр");

    // Статус перечитан с сервера: ждёт клиента, кнопка — «ещё раз».
    await expect(row).toContainText("Приложение: ждёт подтверждения клиента");
    await expect(row.locator(".client-sub")).toContainText("ждёт подтверждения клиента");
    await expect(row.getByRole("button", { name: "Отправить приглашение ещё раз" })).toBeVisible();
  });

  test("подсказка в листе записи: клиент её не увидит", async ({ cabinet }) => {
    const { page } = cabinet;
    const row = await openCard(cabinet, "Вероника");
    await row.getByRole("button", { name: "Изменить" }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "Клиента нет в приложении — эту запись он у себя не увидит."
    );
  });
});

test.describe("Кабинет: клиент уже в приложении — бот пишет сам", () => {
  test.use({
    clients: [
      [
        clientRow(9, { name: "Анна", telegram_username: CLIENT.username, app_match: true }),
        clientRow(10, { name: "Мария", telegram_username: "maria_tg", in_app: true }),
      ],
      { option: true },
    ],
  });

  test("«Пригласить» — приглашение уходит от бота, чат не открывается", async ({ cabinet }) => {
    const { page, backend, openedChats } = cabinet;
    const row = await openCard(cabinet, "Анна");
    await expect(row).toContainText("Клиент уже в приложении — бот пришлёт ему приглашение");

    await row.getByRole("button", { name: "Пригласить в приложение" }).click();

    await expect(page.getByText("Бот отправил клиенту приглашение")).toBeVisible();
    expect(backend.tables.client_invites).toEqual([expect.objectContaining({ client_id: 9, sent: true })]);
    expect(await openedChats()).toEqual([]);
    await expect(row).toContainText("Приложение: ждёт подтверждения клиента");
  });

  test("карточка в приложении — приглашать некого", async ({ cabinet }) => {
    const row = await openCard(cabinet, "Мария");
    await expect(row.locator(".client-sub")).toContainText("в приложении");
    await expect(row.locator(".client-app")).toHaveCount(0);
  });
});

test.describe("Кабинет: приглашение не отправить", () => {
  test.use({
    clients: [
      [
        clientRow(8, { name: "Ольга", phone: "+7 900 000 00 00", channel: "wa" }),
        clientRow(11, { name: "Дарья", telegram_username: "darya_tg" }),
        clientRow(12, { name: "Нина", telegram_username: "nina_tg", invite_status: "accepted" }),
      ],
      { option: true },
    ],
  });

  test("без Telegram клиента — подсказка вместо кнопки", async ({ cabinet }) => {
    const row = await openCard(cabinet, "Ольга");
    await expect(row).toContainText("укажите его Telegram в «Изменить»");
    await expect(row.getByRole("button", { name: "Пригласить в приложение" })).toHaveCount(0);
  });

  test("без логина бота — подсказка про «Настройки»", async ({ cabinet }) => {
    cabinet.backend.tables.settings[0].client_bot_username = "";
    await cabinet.page.reload();
    await expect(cabinet.page.getByRole("heading", { name: "Расписание" })).toBeVisible();
    const row = await openCard(cabinet, "Дарья");
    await expect(row).toContainText("укажите логин бота для клиентов в «Настройках»");
    await expect(row.getByRole("button", { name: "Пригласить в приложение" })).toHaveCount(0);
  });

  test("клиент принял в боте — ждём его входа, кнопки нет", async ({ cabinet }) => {
    const row = await openCard(cabinet, "Нина");
    await expect(row).toContainText("Приложение: клиент принял — ждём входа в приложение");
    await expect(row).toContainText("записи появятся у него, как только он откроет приложение");
    await expect(row.getByRole("button", { name: /Пригласить|приглашение/ })).toHaveCount(0);
  });
});
