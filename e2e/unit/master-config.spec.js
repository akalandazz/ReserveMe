import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { parseMasterConfig, salonAppUrl } from "../../scripts/master-config.mjs";

// Конфиг мастера для scripts/add-master.mjs (scripts/master-config.mjs):
// разбор и проверки — те же границы, что CHECK в supabase/schema.sql. Сети
// и базы нет.

const example = () =>
  JSON.parse(readFileSync(new URL("../../masters/example.json", import.meta.url), "utf8"));

const minimal = (over = {}) => ({
  slug: "anna-nails",
  master: { name: "Анна" },
  bots: { clientToken: "111:abc" },
  ...over,
});

test("пример из masters/example.json — без ошибок, в колонки settings", () => {
  const { errors, plan } = parseMasterConfig(example());
  expect(errors).toEqual([]);
  expect(plan.slug).toBe("anna-nails");
  expect(plan.telegramId).toBe(123456789);
  expect(plan.settings).toMatchObject({
    master_name: "Анна",
    master_username: "anna_nails",
    map_url: "https://yandex.ru/maps/?text=Москва",
    slot_step_minutes: 30,
    reminder_hours: 24,
  });
  // 0 = воскресенье, как working_hours в базе.
  expect(plan.settings.working_hours).toEqual({
    0: null,
    1: { from: "10:00", to: "19:00" },
    2: { from: "10:00", to: "19:00" },
    3: { from: "10:00", to: "19:00" },
    4: { from: "10:00", to: "20:00" },
    5: { from: "10:00", to: "20:00" },
    6: { from: "11:00", to: "17:00" },
  });
  expect(plan.services.map((s) => [s.id, s.sort])).toEqual([
    ["manicure", 10],
    ["pedicure", 20],
  ]);
});

test("минимальный конфиг: необязательного в плане нет — повторный запуск его не тронет", () => {
  const { errors, plan } = parseMasterConfig(minimal());
  expect(errors).toEqual([]);
  expect(plan.settings).toEqual({ master_name: "Анна" });
  expect(plan.services).toEqual([]);
  expect(plan.telegramId).toBeNull();
  expect(plan.telegram).toEqual({ appUrl: "", webhookUrl: "" });
  expect(plan.bots).toEqual({ client: "111:abc", cabinet: null, webhookSecret: null });
});

test("тот же токен у кабинета — один бот, отдельной строки нет", () => {
  const { plan } = parseMasterConfig(minimal({ bots: { clientToken: "111:abc", cabinetToken: "111:abc" } }));
  expect(plan.bots.cabinet).toBeNull();
});

test("юзернейм — без «@»", () => {
  const { plan } = parseMasterConfig(minimal({ master: { name: "Анна", username: "@anna" } }));
  expect(plan.settings.master_username).toBe("anna");
});

test("ошибки — все сразу, понятным текстом, и без плана", () => {
  const { errors, plan } = parseMasterConfig({
    slug: "Anna Nails",
    master: { name: "", telegramId: "123" },
    bots: { clientToken: "not-a-token", webhookSecret: "has space" },
    address: { mapUrl: "javascript:alert(1)" },
    workingHours: { mon: "19:00-10:00", funday: "10:00-11:00" },
    booking: { slotStepMinutes: 25, reminderHours: 100 },
    services: [
      { id: "Manicure", name: "x", price: 100000, duration: 7 },
      { id: "ok_id", name: "", price: 1, duration: 15, note: "x".repeat(121) },
      { id: "ok_id", name: "Дубль", price: 1, duration: 15 },
    ],
    telegram: { appUrl: "http://insecure" },
    typo: true,
  });
  expect(plan).toBeNull();
  const text = errors.join("\n");
  for (const part of [
    "Неизвестное поле «typo»",
    "slug",
    "master.name",
    "master.telegramId",
    "bots.clientToken",
    "bots.webhookSecret",
    "address.mapUrl",
    "workingHours.mon",
    "workingHours.funday",
    "booking.slotStepMinutes",
    "booking.reminderHours",
    "services[0].id",
    "services[0].price",
    "services[0].duration",
    "services[1].name",
    "services[1].note",
    "services[2].id «ok_id» повторяется",
    "telegram.appUrl",
  ]) {
    expect(text, part).toContain(part);
  }
});

test("не объект — одна ошибка", () => {
  expect(parseMasterConfig([]).errors).toEqual(["Конфиг — JSON-объект"]);
});

test("адреса мини-аппов салона — с ?salon=, кабинет — admin.html рядом", () => {
  expect(salonAppUrl("https://host.example/", "anna-nails")).toBe("https://host.example/?salon=anna-nails");
  expect(salonAppUrl("https://host.example/", "anna-nails", { cabinet: true })).toBe(
    "https://host.example/admin.html?salon=anna-nails"
  );
  expect(salonAppUrl("https://host.example/app/index.html", "x1", { cabinet: true })).toBe(
    "https://host.example/app/admin.html?salon=x1"
  );
  expect(salonAppUrl("https://host.example/app", "x1", { cabinet: true })).toBe(
    "https://host.example/app/admin.html?salon=x1"
  );
});
