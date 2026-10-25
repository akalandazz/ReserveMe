import { expect, test } from "@playwright/test";
import {
  ENABLED,
  LOCAL_ONLY,
  admin,
  asRow,
  bookingAsAdmin,
  insertBooking,
  rpc,
  signIn,
  tgUser,
  wipeBookings,
  workdays,
} from "./support.js";

// Несколько услуг в одной записи — services_total() в schema.sql: одно окно
// подряд, длительность и цена — сумма по прайсу, подпись — названия через
// « + », порядок — services.sort. Клиент присылает только id (снимок,
// цену и длительность сервер пишет сам); бандл до нескольких услуг —
// один service_id, это заявка из одной услуги.

test.skip(!ENABLED, "нет SUPABASE_IT_* — локальный Supabase не поднят (см. support.js)");
test.skip(ENABLED && !LOCAL_ONLY, "SUPABASE_IT_URL должен указывать на локальный стек");

const [DAY_A, DAY_B, DAY_C, DAY_D] = workdays();
const LONG = "long_it";

let A, M;
let svc; // id → { name, price, duration, sort } салона 1

const ids = (...list) => list.map((id) => ({ id }));
const snapshot = (...list) =>
  list.map((id) => ({ id, name: svc[id].name, duration: svc[id].duration, price: svc[id].price }));
const byPriceList = (...list) => list.sort((a, b) => svc[a].sort - svc[b].sort);

test.beforeAll(async () => {
  if (!ENABLED || !LOCAL_ONLY) return;
  await wipeBookings();
  A = await signIn(tgUser("Alice"));
  const mUser = tgUser("Master");
  await signIn(mUser);
  await admin(`/rest/v1/profiles?telegram_id=eq.${mUser.id}`, {
    method: "PATCH",
    body: { role: "master" },
  });
  M = await signIn(mUser);

  const rows = (await admin("/rest/v1/services?salon_id=eq.1&select=id,name,price,duration,sort")).data;
  svc = Object.fromEntries(rows.map((r) => [r.id, r]));
});

test.afterAll(async () => {
  if (ENABLED && LOCAL_ONLY) {
    await admin(`/rest/v1/services?salon_id=eq.1&id=eq.${LONG}`, { method: "DELETE" });
  }
});

test.describe("заявка клиента", () => {
  test("две услуги — одно окно, итог и снимок с сервера, в порядке прайса", async () => {
    // Присланы в обратном порядке и с чужими ценами — сервер их не берёт.
    const res = await insertBooking(A.token, {
      day: DAY_A,
      start_min: 600,
      services: [{ id: "pedicure", price: 1 }, { id: "manicure", duration: 5 }],
      price: 1,
      duration: 5,
      service_name: "Подделка",
    });
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    const [first, second] = byPriceList("manicure", "pedicure");
    expect(asRow(res)).toMatchObject({
      services: snapshot(first, second),
      service_id: first,
      service_name: `${svc[first].name} + ${svc[second].name}`,
      duration: svc.manicure.duration + svc.pedicure.duration,
      price: svc.manicure.price + svc.pedicure.price,
      status: "new",
    });
  });

  test("старый бандл (один service_id) — заявка из одной услуги", async () => {
    const res = await insertBooking(A.token, { day: DAY_A, start_min: 900 });
    expect(res.status).toBe(201);
    expect(asRow(res)).toMatchObject({
      services: snapshot("manicure"),
      service_id: "manicure",
      duration: svc.manicure.duration,
    });
  });

  test("окно — под всю сумму: конец за пределами дня не принимается", async () => {
    const one = (await admin("/rest/v1/settings?salon_id=eq.1&select=working_hours")).data[0];
    const dow = new Date(`${DAY_B}T12:00:00Z`).getUTCDay();
    const [h, m] = one.working_hours[dow].to.split(":").map(Number);
    const close = h * 60 + m;
    // Старт на сетке, при котором одна услуга влезает, а обе — нет.
    const latest = close - svc.pedicure.duration;
    const start = latest - (latest % 30);
    expect(start + svc.manicure.duration + svc.pedicure.duration).toBeGreaterThan(close);

    const both = await insertBooking(A.token, {
      day: DAY_B,
      start_min: start,
      services: ids("manicure", "pedicure"),
    });
    expect(both.status).toBe(400);
    expect(both.data.message).toBe("Такого времени нет в расписании");
    const alone = await insertBooking(A.token, { day: DAY_B, start_min: start, services: ids("pedicure") });
    expect(alone.status).toBe(201);
  });

  test("та же услуга дважды, больше четырёх, несуществующая — отказ", async () => {
    const cases = [
      [ids("manicure", "manicure"), "Одна и та же услуга выбрана дважды"],
      [ids("manicure", "pedicure", "design", "manicure_gel", "nope"), "Выберите от 1 до 4 услуг"],
      [ids("manicure", "nope"), "Услуга не найдена"],
    ];
    for (const [services, message] of cases) {
      const res = await insertBooking(A.token, { day: DAY_C, start_min: 600, services });
      expect(res.status, message).toBe(400);
      expect(res.data.message).toBe(message);
    }
  });

  test("сумма длиннее 600 минут — отказ", async () => {
    const add = await admin("/rest/v1/services", {
      method: "POST",
      body: { salon_id: 1, id: LONG, name: "Долгая", price: 100, duration: 600, sort: 99 },
    });
    expect(add.status).toBe(201);
    const res = await insertBooking(A.token, { day: DAY_C, start_min: 600, services: ids("design", LONG) });
    expect(res.status).toBe(400);
    expect(res.data.message).toBe("Слишком долго для одной записи — выберите меньше услуг");
  });

  test("перенос — те же услуги, снова в «Заявки»", async () => {
    const created = asRow(
      await insertBooking(A.token, { day: DAY_C, start_min: 600, services: ids("manicure", "design") })
    );
    await admin(`/rest/v1/bookings?id=eq.${created.id}`, { method: "PATCH", body: { status: "ok" } });

    const res = await rpc(
      "reschedule_own_booking",
      { p_id: created.id, p_day: DAY_D, p_start_min: 660 },
      A.token
    );
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(await bookingAsAdmin(created.id)).toMatchObject({
      day: DAY_D,
      start_min: 660,
      status: "new",
      services: created.services,
      duration: created.duration,
      price: created.price,
    });
  });
});

test.describe("мастер", () => {
  test("free_slots — под сумму длительностей", async () => {
    const one = await rpc("free_slots", { p_day: DAY_D, p_service_ids: ["manicure"] }, M.token);
    const two = await rpc("free_slots", { p_day: DAY_D, p_service_ids: ["manicure", "pedicure"] }, M.token);
    expect(two.status).toBe(200);
    const last = (r) => r.data.at(-1).start_min;
    expect(last(one) - last(two)).toBe(svc.pedicure.duration);
    // Хоть одна услуга не нашлась — свободного времени нет, без ошибки.
    const bad = await rpc("free_slots", { p_day: DAY_D, p_service_ids: ["manicure", "nope"] }, M.token);
    expect(bad.status).toBe(200);
    expect(bad.data).toEqual([]);
  });

  const masterBooking = (serviceIds, day, startMin, name) =>
    rpc(
      "create_master_booking",
      {
        p_client_id: null,
        p_new_name: name,
        p_new_phone: "",
        p_new_telegram: "",
        p_new_channel: "wa",
        p_service_ids: serviceIds,
        p_day: day,
        p_start_min: startMin,
        p_comment: "",
      },
      M.token
    );

  test("create_master_booking — несколько услуг одной записью", async () => {
    const res = await masterBooking(["design", "manicure"], DAY_B, 600, "Вера");
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(await bookingAsAdmin(res.data)).toMatchObject({
      status: "ok",
      services: snapshot(...byPriceList("manicure", "design")),
      duration: svc.manicure.duration + svc.design.duration,
      price: svc.manicure.price + svc.design.price,
    });
  });

  test("update_master_booking: тот же набор — согласованная цена остаётся, другой — по прайсу", async () => {
    const created = await masterBooking(["manicure", "design"], DAY_C, 900, "Ольга");
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const id = created.data;
    // Скидка, о которой договорились, — на строке.
    await admin(`/rest/v1/bookings?id=eq.${id}`, { method: "PATCH", body: { price: 1000 } });
    const row = await bookingAsAdmin(id);

    const edit = (serviceIds) =>
      rpc(
        "update_master_booking",
        {
          p_id: id,
          p_client_id: row.client_id,
          p_client_name: "Ольга",
          p_client_phone: "",
          p_client_telegram: "",
          p_client_channel: null,
          p_service_ids: serviceIds,
          p_day: DAY_C,
          p_start_min: 900,
          p_comment: "",
        },
        M.token
      );

    // Тот же набор в другом порядке — та же запись.
    expect((await edit(["design", "manicure"])).status).toBe(204);
    expect(await bookingAsAdmin(id)).toMatchObject({ price: 1000, services: row.services });

    expect((await edit(["manicure"])).status).toBe(204);
    expect(await bookingAsAdmin(id)).toMatchObject({
      price: svc.manicure.price,
      duration: svc.manicure.duration,
      services: snapshot("manicure"),
      service_name: svc.manicure.name,
    });
  });
});
