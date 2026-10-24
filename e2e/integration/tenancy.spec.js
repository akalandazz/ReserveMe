import { expect, test } from "@playwright/test";
import {
  CLIENT_BOT,
  ENABLED,
  IT,
  LOCAL_ONLY,
  admin,
  api,
  asRow,
  bookingAsAdmin,
  insertBooking,
  login,
  rpc,
  signIn,
  signInitData,
  tgUser,
  wipeBookings,
  workdays,
} from "./support.js";

// Салоны (тенанты, «Салоны» в supabase/schema.sql) на локальном Supabase:
// мастер и клиенты одного салона не видят и не трогают другой — ни через
// таблицы (RLS), ни через функции, ни через вход.
//
// Салон 1 — из сида schema.sql, его боты — секреты функции (config.toml).
// Салон 2 («beta») заводится здесь, его боты — в salon_bots.

test.skip(!ENABLED, "нет SUPABASE_IT_* — локальный Supabase не поднят (см. support.js)");
test.skip(ENABLED && !LOCAL_ONLY, "SUPABASE_IT_URL должен указывать на локальный стек");

const BETA = { id: 2, slug: "beta" };
const BETA_CLIENT_BOT = "333333:local-test-beta-client-bot";
const BETA_CABINET_BOT = "444444:local-test-beta-cabinet-bot";
const UPSERT = { prefer: "resolution=merge-duplicates,return=minimal" };

let M1, C1; // мастер и клиент салона 1
let M2, C2; // мастер и клиент салона beta
let b1, b2; // заявки C1 и C2 — на одно и то же время
const [DAY, DAY_X] = workdays();

async function makeMaster(user, opts) {
  await signIn(user, opts);
  await admin(`/rest/v1/profiles?telegram_id=eq.${user.id}`, {
    method: "PATCH",
    body: { role: "master" },
  });
  return signIn(user, opts);
}

const bookingIds = async (token) =>
  (await api("/rest/v1/bookings?select=id", { token })).data.map((r) => r.id);

/** { day, start_min } через hoursAhead часов по Тбилиси, на 5-минутной сетке. */
function tbilisiSlot(hoursAhead) {
  const at = new Date(Date.now() + hoursAhead * 3_600_000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tbilisi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value])
  );
  const min = Number(p.hour) * 60 + Number(p.minute);
  return { day: `${p.year}-${p.month}-${p.day}`, start_min: min - (min % 5) };
}

test.beforeAll(async () => {
  if (!ENABLED || !LOCAL_ONLY) return;
  await wipeBookings();

  // Салон beta: боты, настройки (тот же график, другое имя) и услуга с тем
  // же id, что у салона 1, — ключи теперь в пределах салона.
  const setup = async (path, body) => {
    const res = await admin(path, { method: "POST", headers: UPSERT, body });
    // 201 — новая строка, 200 — уже была (прошлый прогон), merge-duplicates.
    expect([200, 201], `${path}: ${JSON.stringify(res.data)}`).toContain(res.status);
  };
  await setup("/rest/v1/salons", BETA);
  await setup("/rest/v1/salon_bots", [
    { salon_id: BETA.id, kind: "client", token: BETA_CLIENT_BOT, webhook_secret: "beta-secret" },
    { salon_id: BETA.id, kind: "cabinet", token: BETA_CABINET_BOT, webhook_secret: "" },
  ]);
  const one = (await admin("/rest/v1/settings?salon_id=eq.1&select=working_hours,time_of_day")).data[0];
  await setup("/rest/v1/settings", { salon_id: BETA.id, master_name: "Бета", reminder_hours: 24, ...one });
  await setup("/rest/v1/services", {
    salon_id: BETA.id,
    id: "manicure",
    name: "Маникюр беты",
    price: 777,
    duration: 60,
  });

  M1 = await makeMaster(tgUser("MasterOne"));
  C1 = await signIn(tgUser("ClientOne"));
  M2 = await makeMaster(tgUser("MasterBeta"), { token: BETA_CABINET_BOT, salon: BETA.slug });
  C2 = await signIn(tgUser("ClientBeta"), { token: BETA_CLIENT_BOT, salon: BETA.slug });

  b1 = asRow(await insertBooking(C1.token, { day: DAY, start_min: 600 }));
  b2 = asRow(await insertBooking(C2.token, { day: DAY, start_min: 600 }));
});

test.describe("вход: салон выбирает бот", () => {
  test("аккаунт заводится в салоне бота, которым вошёл", async () => {
    const salonOf = async (u) =>
      (await admin(`/rest/v1/profiles?id=eq.${u.uid}&select=salon_id`)).data[0].salon_id;
    expect(await salonOf(C1)).toBe(1);
    expect(await salonOf(C2)).toBe(BETA.id);
    expect(await salonOf(M2)).toBe(BETA.id);
  });

  test("клиент салона 1 у бота beta — 403 other_salon, ничего не пишется", async () => {
    const before = (await admin(`/rest/v1/profiles?id=eq.${C1.uid}&select=*`)).data[0];
    const res = await login(signInitData(C1.tg, { token: BETA_CLIENT_BOT }), { salon: BETA.slug });
    expect(res).toEqual({ status: 403, data: { error: "other_salon" } });
    expect((await admin(`/rest/v1/profiles?id=eq.${C1.uid}&select=*`)).data[0]).toEqual(before);
  });

  test("initData бота салона 1 с чужим slug — 401 (slug — не пропуск)", async () => {
    const res = await login(signInitData(tgUser("Sneaky"), { token: CLIENT_BOT }), { salon: BETA.slug });
    expect(res).toEqual({ status: 401, data: { error: "invalid_init_data" } });
    // И наоборот: бот beta без slug — проверяется токенами салона 1.
    const back = await login(signInitData(tgUser("Lost"), { token: BETA_CLIENT_BOT }));
    expect(back.status).toBe(401);
  });

  test("неизвестный или кривой slug — 401", async () => {
    for (const salon of ["nope", "../etc", "BETA"]) {
      const res = await login(signInitData(tgUser("Ghost"), { token: BETA_CLIENT_BOT }), { salon });
      expect(res.status, salon).toBe(401);
    }
  });
});

test.describe("клиент видит только свой салон", () => {
  test("настройки и услуги — своего салона", async () => {
    const s1 = await api("/rest/v1/settings?select=master_name,salon_id", { token: C1.token });
    const s2 = await api("/rest/v1/settings?select=master_name,salon_id", { token: C2.token });
    expect(s1.data).toHaveLength(1);
    expect(s1.data[0].salon_id).toBe(1);
    expect(s2.data).toEqual([{ master_name: "Бета", salon_id: BETA.id }]);

    const svc2 = await api("/rest/v1/services?select=salon_id,id,price", { token: C2.token });
    expect(svc2.data).toEqual([{ salon_id: BETA.id, id: "manicure", price: 777 }]);
  });

  test("заявка — по прайсу своего салона, salon_id не подделать", async () => {
    expect(b2).toMatchObject({ salon_id: BETA.id, price: 777, duration: 60, service_name: "Маникюр беты" });
    expect(b1.salon_id).toBe(1);
    const forged = await insertBooking(C2.token, { day: DAY, start_min: 720, salon_id: 1 });
    expect(forged.status).toBe(201);
    expect(asRow(forged).salon_id).toBe(BETA.id);
  });

  test("занятость — только своего салона", async () => {
    const busy = async (token) =>
      (await api(`/rest/v1/busy_slots?day=eq.${DAY}&select=start_min,duration`, { token })).data;
    // У обоих занято 10:00 — но каждый видит только свою заявку.
    expect(await busy(C1.token)).toContainEqual({ start_min: 600, duration: b1.duration });
    expect(await busy(C2.token)).toContainEqual({ start_min: 600, duration: b2.duration });
    expect(await busy(C2.token)).not.toContainEqual({ start_min: 600, duration: b1.duration });
    expect((await api("/rest/v1/busy_slots?select=day")).data).toEqual([]); // аноним
  });

  test("контент анониму не отдаётся", async () => {
    for (const t of ["settings", "services", "days_off", "days_open", "info_blocks", "blocked_slots"]) {
      expect((await api(`/rest/v1/${t}?select=*`)).data, t).toEqual([]);
    }
  });

  test("чужая запись по id — пусто, отмена — 403", async () => {
    expect((await api(`/rest/v1/bookings?id=eq.${b1.id}&select=id`, { token: C2.token })).data).toEqual([]);
    expect((await rpc("cancel_own_booking", { p_id: b1.id }, C2.token)).status).toBe(403);
  });

  test("чужую запись не перенести — 403, строка не меняется", async () => {
    const before = await bookingAsAdmin(b1.id);
    const res = await rpc(
      "reschedule_own_booking",
      { p_id: b1.id, p_day: DAY_X, p_start_min: 660 },
      C2.token
    );
    expect(res.status).toBe(403);
    expect(await bookingAsAdmin(b1.id)).toEqual(before);
  });

  test("set_reminders меняет только свой профиль", async () => {
    const remindersOf = async (u) =>
      (await admin(`/rest/v1/profiles?id=eq.${u.uid}&select=reminders`)).data[0].reminders;
    const before = await remindersOf(C1);
    expect((await rpc("set_reminders", { p_enabled: !before }, C2.token)).status).toBe(200);
    expect(await remindersOf(C1)).toBe(before);
    expect(await remindersOf(C2)).toBe(!before);
    await rpc("set_reminders", { p_enabled: true }, C2.token);
  });

  test("поддельная строка в чужой салон — 403, клиенты того салона не тронуты", async () => {
    // source = 'master' guard_client_booking не чистит; link_booking_client
    // не должен успеть поработать с клиентами салона 1 до отказа RLS, и ответ
    // не должен зависеть от того, есть ли такой аккаунт в салоне 1 (M1 — есть,
    // случайный uuid — нет; раньше это было 403 против 409).
    const clientsBefore = (await admin("/rest/v1/clients?salon_id=eq.1&select=*&order=id")).data;
    for (const userId of [M1.uid, crypto.randomUUID()]) {
      const res = await api("/rest/v1/bookings", {
        method: "POST",
        token: C2.token,
        body: {
          salon_id: 1,
          day: DAY_X,
          start_min: 900,
          duration: 60,
          price: 1,
          service_id: "manicure",
          service_name: "x",
          client_name: "Подделка",
          status: "ok",
          source: "master",
          user_id: userId,
        },
      });
      expect(res.status, userId === M1.uid ? "аккаунт салона 1" : "случайный uuid").toBe(403);
    }
    expect((await admin("/rest/v1/clients?salon_id=eq.1&select=*&order=id")).data).toEqual(clientsBefore);
  });
});

test.describe("мастер видит и правит только свой салон", () => {
  test("записи, клиенты, статистика — свои", async () => {
    expect(await bookingIds(M1.token)).toContain(b1.id);
    expect(await bookingIds(M1.token)).not.toContain(b2.id);
    expect(await bookingIds(M2.token)).toContain(b2.id);
    expect(await bookingIds(M2.token)).not.toContain(b1.id);

    for (const t of ["clients", "client_stats"]) {
      const ids = (await api(`/rest/v1/${t}?select=id`, { token: M2.token })).data.map((r) => r.id);
      expect(ids, t).toContain(b2.client_id);
      expect(ids, t).not.toContain(b1.client_id);
    }
  });

  test("функции мастера на чужие id — ничего не меняют", async () => {
    const before = await bookingAsAdmin(b1.id);
    const calls = [
      ["approve_booking", { p_id: b1.id }],
      [
        "update_master_booking",
        {
          p_id: b1.id,
          p_client_id: b1.client_id,
          p_client_name: "Захват",
          p_client_phone: "",
          p_client_telegram: "",
          p_client_channel: null,
          p_service_id: "manicure",
          p_day: DAY_X,
          p_start_min: 600,
          p_comment: "",
        },
      ],
      [
        "create_master_booking",
        {
          p_client_id: b1.client_id,
          p_new_name: null,
          p_new_phone: null,
          p_new_telegram: null,
          p_new_channel: null,
          p_service_id: "manicure",
          p_day: DAY_X,
          p_start_min: 600,
          p_comment: "",
        },
      ],
    ];
    for (const [name, args] of calls) {
      const res = await rpc(name, args, M2.token);
      expect(res.status, `${name}: ${JSON.stringify(res.data)}`).toBeGreaterThanOrEqual(400);
    }
    // Чужой клиент для delete_client — как несуществующий.
    expect((await rpc("delete_client", { p_id: b1.client_id }, M2.token)).data).toEqual([
      { bookings_deleted: 0, comments_deleted: 0 },
    ]);
    expect(await bookingAsAdmin(b1.id)).toEqual(before);
  });

  test("прямые PATCH/DELETE чужих строк не затрагивают их", async () => {
    const before = await bookingAsAdmin(b1.id);
    await api(`/rest/v1/bookings?id=eq.${b1.id}`, {
      method: "PATCH",
      token: M2.token,
      body: { status: "cancelled", cancelled_by: "master" },
    });
    await api(`/rest/v1/bookings?id=eq.${b1.id}`, { method: "DELETE", token: M2.token });
    await api(`/rest/v1/clients?id=eq.${b1.client_id}`, {
      method: "PATCH",
      token: M2.token,
      body: { name: "Захват" },
    });
    expect(await bookingAsAdmin(b1.id)).toEqual(before);
    const client = (await admin(`/rest/v1/clients?id=eq.${b1.client_id}&select=name`)).data[0];
    expect(client.name).not.toBe("Захват");
  });

  test("свою строку не перенести в чужой салон", async () => {
    const res = await api(`/rest/v1/bookings?id=eq.${b2.id}`, {
      method: "PATCH",
      token: M2.token,
      body: { salon_id: 1 },
    });
    // RLS (with check) или составной внешний ключ — смотря что сработает первым.
    expect([403, 409]).toContain(res.status);
    expect((await bookingAsAdmin(b2.id)).salon_id).toBe(BETA.id);
  });

  test("ссылки в чужой салон не принимает сама база", async () => {
    // Запись с user_id клиента салона 1 — она появилась бы у него в «Мои записи».
    const foreignUser = await api("/rest/v1/bookings", {
      method: "POST",
      token: M2.token,
      body: {
        day: DAY_X,
        start_min: 900,
        duration: 60,
        price: 1,
        service_id: "manicure",
        service_name: "x",
        status: "ok",
        source: "master",
        user_id: C1.uid,
      },
    });
    expect(foreignUser.status).toBe(409);
    expect(await bookingIds(C1.token)).toEqual([b1.id]);

    // Клиент с чужим аккаунтом и комментарий к чужому клиенту.
    const foreignClient = await api("/rest/v1/clients", {
      method: "POST",
      token: M2.token,
      body: { name: "Чужой", user_id: C1.uid },
    });
    expect(foreignClient.status).toBe(409);
    const foreignComment = await api("/rest/v1/client_comments", {
      method: "POST",
      token: M2.token,
      body: { client_id: b1.client_id, body: "чужой клиент" },
    });
    expect(foreignComment.status).toBe(409);
  });

  test("настройки — правит только свою строку", async () => {
    const res = await api("/rest/v1/settings?salon_id=not.is.null", {
      method: "PATCH",
      token: M2.token,
      body: { address: "Адрес беты" },
    });
    expect(res.status).toBe(204);
    const all = (await admin("/rest/v1/settings?select=salon_id,address")).data;
    expect(all.find((s) => s.salon_id === BETA.id).address).toBe("Адрес беты");
    expect(all.find((s) => s.salon_id === 1).address).not.toBe("Адрес беты");
  });

  test("одно и то же время подтверждается в обоих салонах", async () => {
    expect((await rpc("approve_booking", { p_id: b1.id }, M1.token)).status).toBe(204);
    expect((await rpc("approve_booking", { p_id: b2.id }, M2.token)).status).toBe(204);
    expect((await bookingAsAdmin(b1.id)).status).toBe("ok");
    expect((await bookingAsAdmin(b2.id)).status).toBe("ok");
  });

  test("free_slots — по своему салону", async () => {
    const free = async (token) =>
      (await rpc("free_slots", { p_day: DAY, p_service_id: "manicure" }, token)).data.map(
        (r) => r.start_min
      );
    // Бета: услуга 60 минут, 10:00–11:00 занято её записью — 11:00 свободно.
    const beta = await free(M2.token);
    expect(beta).not.toContain(600);
    expect(beta).toContain(660);
    // Салон 1: запись C1 — 90 минут, 10:00–11:30; запись беты не мешает.
    const one = await free(M1.token);
    expect(one).not.toContain(660);
    expect(one).toContain(690);
  });
});

test.describe("контент и комментарии чужого салона", () => {
  // Строки салона 1 в каждой таблице контента, плюс комментарий к его клиенту.
  const rows = {};

  test.beforeAll(async () => {
    if (!ENABLED || !LOCAL_ONLY) return;
    const add = async (table, body) => {
      const res = await admin(`/rest/v1/${table}`, { method: "POST", headers: { prefer: "return=representation" }, body });
      expect(res.status, `${table}: ${JSON.stringify(res.data)}`).toBe(201);
      rows[table] = asRow(res);
    };
    await add("days_open", { salon_id: 1, day: DAY_X, hours: { from: "10:00", to: "12:00" } });
    await add("blocked_slots", { salon_id: 1, day: DAY_X, start_min: 1080 });
    await add("client_comments", { salon_id: 1, client_id: b1.client_id, body: "заметка мастера 1" });
  });

  test.afterAll(async () => {
    if (!ENABLED || !LOCAL_ONLY) return;
    await admin(`/rest/v1/days_open?salon_id=eq.1&day=eq.${DAY_X}`, { method: "DELETE" });
    await admin(`/rest/v1/blocked_slots?salon_id=eq.1&day=eq.${DAY_X}`, { method: "DELETE" });
  });

  const TABLES = ["days_off", "days_open", "info_blocks", "blocked_slots"];
  const salonRows = async (table) => (await admin(`/rest/v1/${table}?salon_id=eq.1&select=*`)).data;

  test("мастер и клиент другого салона их не читают", async () => {
    for (const t of [...TABLES, "client_comments"]) {
      for (const [who, u] of [["M2", M2], ["C2", C2]]) {
        const got = (await api(`/rest/v1/${t}?select=salon_id`, { token: u.token })).data;
        expect(got.filter((r) => r.salon_id !== BETA.id), `${who} ${t}`).toEqual([]);
      }
    }
    // А свой мастер — видит (иначе проверка выше ничего не доказывает).
    const own = (await api("/rest/v1/client_comments?select=id", { token: M1.token })).data;
    expect(own.map((r) => r.id)).toContain(rows.client_comments.id);
  });

  test("мастер другого салона их не правит, не удаляет и не дописывает", async () => {
    const before = Object.fromEntries(
      await Promise.all([...TABLES, "client_comments"].map(async (t) => [t, await salonRows(t)]))
    );
    for (const t of [...TABLES, "client_comments"]) {
      await api(`/rest/v1/${t}?salon_id=eq.1`, { method: "DELETE", token: M2.token });
    }
    await api("/rest/v1/info_blocks?salon_id=eq.1", { method: "PATCH", token: M2.token, body: { title: "Захват" } });
    await api(`/rest/v1/days_open?salon_id=eq.1`, {
      method: "PATCH",
      token: M2.token,
      body: { hours: { from: "08:00", to: "09:00" } },
    });
    for (const t of [...TABLES, "client_comments"]) {
      expect(await salonRows(t), t).toEqual(before[t]);
    }

    // Вставка с salon_id = 1 — отказ RLS (with check), строка не появляется.
    const forged = await api("/rest/v1/days_off", {
      method: "POST",
      token: M2.token,
      body: { salon_id: 1, day: DAY_X },
    });
    expect(forged.status).toBe(403);
    expect(await salonRows("days_off")).toEqual(before.days_off);
  });
});

test.describe("напоминания", () => {
  test("claim_due_reminders отдаёт салон записи и его настройки", async () => {
    const row = asRow(
      await admin("/rest/v1/bookings", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: {
          salon_id: BETA.id,
          ...tbilisiSlot(3),
          duration: 30,
          price: 1,
          service_id: "manicure",
          service_name: "Маникюр беты",
          status: "ok",
          source: "master",
          user_id: C2.uid,
        },
      })
    );
    const claimed = await rpc("claim_due_reminders", { p_limit: 50 }, IT.service);
    expect(claimed.status).toBe(200);
    expect(claimed.data.find((r) => r.booking_id === row.id)).toMatchObject({
      salon_id: BETA.id,
      telegram_id: C2.tg.id,
      master_name: "Бета",
    });
  });
});
