import { expect, test } from "@playwright/test";
import {
  ENABLED,
  LOCAL_ONLY,
  admin,
  api,
  asRow,
  bookingAsAdmin,
  insertBooking,
  rpc,
  signIn,
  tgUser,
  wipeBookings,
  workdays,
} from "./support.js";

// Авторизация: RLS и функции из supabase/schema.sql на локальном Supabase.
// Пользователи входят через настоящую telegram-auth.
//
// Коды: отказ функции или нарушение политики на запись — 403 (42501)
// для вошедшего, 401 для анонима. Чтение чужих строк — НЕ 403: RLS
// фильтрует строки, и чужая запись просто не приходит (200, []).

test.skip(!ENABLED, "нет SUPABASE_IT_* — локальный Supabase не поднят (см. support.js)");
test.skip(ENABLED && !LOCAL_ONLY, "SUPABASE_IT_URL должен указывать на локальный стек");

// Тесты файла идут по порядку в одном воркере: записи A и B заводятся в
// beforeAll и используются дальше.

let A, B, M; // клиент A, клиент B, мастер
let aBooking, bBooking;
const [DAY_C, DAY_M, DAY_X] = workdays();

test.beforeAll(async () => {
  if (!ENABLED || !LOCAL_ONLY) return;
  await wipeBookings();
  A = await signIn(tgUser("Alice"));
  B = await signIn(tgUser("Bob"));
  const mUser = tgUser("Master");
  await signIn(mUser);
  await admin(`/rest/v1/profiles?telegram_id=eq.${mUser.id}`, {
    method: "PATCH",
    body: { role: "master" },
  });
  M = await signIn(mUser);

  aBooking = asRow(await insertBooking(A.token, { day: DAY_C, start_min: 600 }));
  bBooking = asRow(await insertBooking(B.token, { day: DAY_C, start_min: 720 }));
});

test.describe("клиент: свои записи", () => {
  test("создаёт заявку себе; владелец, создатель и имя — с сервера", async () => {
    const res = await insertBooking(A.token, {
      day: DAY_C,
      start_min: 660,
      client_name: "Hacker",
      client_username: "someone_else",
      user_id: B.uid, // попытка записать на B
      created_by: B.uid,
      price: 1,
      duration: 600,
    });
    expect(res.status).toBe(201);
    expect(asRow(res)).toMatchObject({
      user_id: A.uid,
      created_by: A.uid,
      client_name: "Alice",
      client_username: A.tg.username,
      price: 50,
      duration: 90,
      status: "new",
      source: "client",
    });
  });

  test("не может создать подтверждённую или «мастерскую» запись", async () => {
    // status: "ok" от клиента триггер просто перезаписывает — заявка.
    const ok = await insertBooking(A.token, { day: DAY_C, start_min: 780, status: "ok" });
    expect(ok.status).toBe(201);
    expect(asRow(ok).status).toBe("new");
    // source: "master" — мимо триггера, но политика не пускает: 403.
    const master = await insertBooking(A.token, { day: DAY_C, start_min: 780, source: "master" });
    expect(master.status).toBe(403);
  });

  test("видит только свои записи", async () => {
    const res = await api("/rest/v1/bookings?select=id,user_id", { token: A.token });
    expect(res.status).toBe(200);
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data.every((r) => r.user_id === A.uid)).toBe(true);
    expect(res.data.map((r) => r.id)).toContain(aBooking.id);
  });

  test("чужая запись по id не приходит (RLS: 200, пусто)", async () => {
    const res = await api(`/rest/v1/bookings?id=eq.${bBooking.id}&select=*`, { token: A.token });
    expect(res).toEqual({ status: 200, data: [] });
  });

  test("переносит свою запись — снова заявка", async () => {
    await admin(`/rest/v1/bookings?id=eq.${aBooking.id}`, { method: "PATCH", body: { status: "ok" } });
    const res = await api("/rest/v1/rpc/reschedule_own_booking", {
      method: "POST",
      token: A.token,
      headers: { accept: "application/vnd.pgrst.object+json" },
      body: { p_id: aBooking.id, p_day: DAY_X, p_start_min: 630 },
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id: aBooking.id, day: DAY_X, start_min: 630, status: "new" });
  });

  test("перенос на время вне расписания — отказ сервера", async () => {
    const res = await rpc(
      "reschedule_own_booking",
      { p_id: aBooking.id, p_day: DAY_X, p_start_min: 23 * 60 },
      A.token
    );
    expect(res.status).toBe(400);
    expect(res.data.message).toBe("Такого времени нет в расписании");
  });

  test("отменяет свою запись", async () => {
    const own = asRow(await insertBooking(A.token, { day: DAY_C, start_min: 840 }));
    const res = await rpc("cancel_own_booking", { p_id: own.id }, A.token);
    expect(res).toEqual({ status: 200, data: true });
    expect(await bookingAsAdmin(own.id)).toMatchObject({ status: "cancelled", cancelled_by: "client" });
  });
});

test.describe("клиент: чужие записи — 403, ничего не меняется", () => {
  test("перенос чужой записи", async () => {
    const before = await bookingAsAdmin(bBooking.id);
    const res = await rpc(
      "reschedule_own_booking",
      { p_id: bBooking.id, p_day: DAY_X, p_start_min: 600 },
      A.token
    );
    expect(res.status).toBe(403);
    expect(await bookingAsAdmin(bBooking.id)).toEqual(before);
  });

  test("отмена чужой записи", async () => {
    const res = await rpc("cancel_own_booking", { p_id: bBooking.id }, A.token);
    expect(res.status).toBe(403);
    expect((await bookingAsAdmin(bBooking.id)).status).toBe("new");
  });

  test("несуществующий id — тот же 403 (не перебрать чужие id)", async () => {
    const res = await rpc("cancel_own_booking", { p_id: 987654321 }, A.token);
    expect(res.status).toBe(403);
  });

  test("прямой PATCH/DELETE чужой строки не затрагивает её", async () => {
    const before = await bookingAsAdmin(bBooking.id);
    await api(`/rest/v1/bookings?id=eq.${bBooking.id}`, {
      method: "PATCH",
      token: A.token,
      body: { day: DAY_X, user_id: A.uid },
    });
    await api(`/rest/v1/bookings?id=eq.${bBooking.id}`, { method: "DELETE", token: A.token });
    expect(await bookingAsAdmin(bBooking.id)).toEqual(before);
  });

  test("прямой PATCH своей строки тоже закрыт (только через функции)", async () => {
    const before = await bookingAsAdmin(aBooking.id);
    await api(`/rest/v1/bookings?id=eq.${aBooking.id}`, {
      method: "PATCH",
      token: A.token,
      body: { status: "ok", price: 0 },
    });
    expect(await bookingAsAdmin(aBooking.id)).toEqual(before);
  });
});

test.describe("клиент: эндпоинты мастера — 403", () => {
  const masterCalls = () => [
    ["approve_booking", { p_id: bBooking.id }],
    ["free_slots", { p_day: DAY_M, p_service_id: "manicure" }],
    ["free_slot_counts", { p_from: DAY_M, p_days: 3, p_service_id: "manicure" }],
    [
      "create_master_booking",
      {
        p_client_id: bBooking.client_id,
        p_new_name: null,
        p_new_phone: null,
        p_new_telegram: null,
        p_new_channel: null,
        p_service_id: "manicure",
        p_day: DAY_M,
        p_start_min: 600,
        p_comment: "",
      },
    ],
    [
      "update_master_booking",
      {
        p_id: bBooking.id,
        p_client_id: bBooking.client_id,
        p_client_name: "x",
        p_client_phone: "",
        p_client_telegram: "",
        p_client_channel: null,
        p_service_id: "manicure",
        p_day: DAY_M,
        p_start_min: 600,
        p_comment: "",
      },
    ],
    ["delete_client", { p_id: bBooking.client_id }],
  ];

  test("функции мастера", async () => {
    for (const [name, args] of masterCalls()) {
      const res = await rpc(name, args, A.token);
      expect(res.status, name).toBe(403);
    }
    expect(await bookingAsAdmin(bBooking.id)).toMatchObject({ status: "new", day: DAY_C });
  });

  test("таблицы мастера: чтение пустое, запись — 403", async () => {
    for (const t of ["clients", "client_stats", "client_comments"]) {
      expect((await api(`/rest/v1/${t}?select=*`, { token: A.token })).data, t).toEqual([]);
    }
    const svc = await api("/rest/v1/services", {
      method: "POST",
      token: A.token,
      body: { id: "hack", name: "Hack", price: 1, duration: 15 },
    });
    expect(svc.status).toBe(403);
    const block = await api("/rest/v1/blocked_slots", {
      method: "POST",
      token: A.token,
      body: { day: DAY_M, start_min: 600 },
    });
    expect(block.status).toBe(403);
  });

  test("свою роль не поднять", async () => {
    const patch = await api(`/rest/v1/profiles?id=eq.${A.uid}`, {
      method: "PATCH",
      token: A.token,
      body: { role: "master" },
    });
    expect(patch.status).toBe(403);
    const insert = await api("/rest/v1/profiles", {
      method: "POST",
      token: A.token,
      body: { id: A.uid, telegram_id: A.tg.id, role: "master" },
    });
    expect(insert.status).toBe(403);
    const mine = await api(`/rest/v1/profiles?id=eq.${A.uid}&select=role`, { token: A.token });
    expect(mine.data).toEqual([{ role: "user" }]);
  });

  test("профиль другого пользователя не читается", async () => {
    const res = await api(`/rest/v1/profiles?id=eq.${B.uid}&select=*`, { token: A.token });
    expect(res.data).toEqual([]);
  });
});

test.describe("аноним — 401", () => {
  test("функции клиента и вставка заявки", async () => {
    expect((await rpc("cancel_own_booking", { p_id: aBooking.id })).status).toBe(401);
    expect(
      (await rpc("reschedule_own_booking", { p_id: aBooking.id, p_day: DAY_X, p_start_min: 600 })).status
    ).toBe(401);
    expect((await insertBooking(undefined, { day: DAY_C })).status).toBe(401);
    expect((await rpc("approve_booking", { p_id: aBooking.id })).status).toBe(401);
    // Чтение bookings анониму — пусто (политик для anon нет).
    expect((await api("/rest/v1/bookings?select=id")).data).toEqual([]);
  });
});

test.describe("мастер", () => {
  test("видит все записи", async () => {
    const res = await api("/rest/v1/bookings?select=id,user_id", { token: M.token });
    const ids = res.data.map((r) => r.id);
    expect(ids).toContain(aBooking.id);
    expect(ids).toContain(bBooking.id);
  });

  test("переносит запись клиента — она остаётся клиенту", async () => {
    const res = await rpc(
      "update_master_booking",
      {
        p_id: bBooking.id,
        p_client_id: bBooking.client_id,
        p_client_name: "Bob",
        p_client_phone: "",
        p_client_telegram: B.tg.username,
        p_client_channel: null,
        p_service_id: "manicure",
        p_day: DAY_M,
        p_start_min: 900,
        p_comment: "перенесла мастер",
      },
      M.token
    );
    expect(res.status).toBe(204);
    const seenByB = await api(`/rest/v1/bookings?id=eq.${bBooking.id}&select=*`, { token: B.token });
    expect(seenByB.data[0]).toMatchObject({
      day: DAY_M,
      start_min: 900,
      status: "ok",
      user_id: B.uid,
      created_by: B.uid, // создал клиент, перенесла мастер
    });
  });

  test("записывает клиента сама: владелец — клиент, создатель — мастер", async () => {
    const res = await rpc(
      "create_master_booking",
      {
        p_client_id: bBooking.client_id,
        p_new_name: null,
        p_new_phone: null,
        p_new_telegram: null,
        p_new_channel: null,
        p_service_id: "manicure",
        p_day: DAY_M,
        p_start_min: 600,
        p_comment: "по звонку",
      },
      M.token
    );
    expect(res.status).toBe(200);
    expect(await bookingAsAdmin(res.data)).toMatchObject({
      user_id: B.uid,
      created_by: M.uid,
      source: "master",
      status: "ok",
      client_id: bBooking.client_id,
    });
    // Клиент видит её в «Мои записи».
    const mine = await api(`/rest/v1/bookings?id=eq.${res.data}&select=id`, { token: B.token });
    expect(mine.data).toEqual([{ id: res.data }]);
  });

  test("записывает нового клиента без аккаунта — ничей user_id", async () => {
    const res = await rpc(
      "create_master_booking",
      {
        p_client_id: null,
        p_new_name: "Позвонила сама",
        p_new_phone: "+995 555 000 000",
        p_new_telegram: "",
        p_new_channel: "call",
        p_service_id: "manicure",
        p_day: DAY_M,
        p_start_min: 750,
        p_comment: "",
      },
      M.token
    );
    expect(res.status).toBe(200);
    expect(await bookingAsAdmin(res.data)).toMatchObject({ user_id: null, created_by: M.uid });
  });

  test("подтверждает и отменяет заявку клиента", async () => {
    const own = asRow(await insertBooking(A.token, { day: DAY_X, start_min: 900 }));
    expect((await rpc("approve_booking", { p_id: own.id }, M.token)).status).toBe(204);
    const cancel = await api(`/rest/v1/bookings?id=eq.${own.id}`, {
      method: "PATCH",
      token: M.token,
      body: { status: "cancelled", cancelled_by: "master" },
    });
    expect(cancel.status).toBe(204);
    const seenByA = await api(`/rest/v1/bookings?id=eq.${own.id}&select=status,cancelled_by`, {
      token: A.token,
    });
    expect(seenByA.data).toEqual([{ status: "cancelled", cancelled_by: "master" }]);
  });

  test("снятая роль действует сразу — без нового входа", async () => {
    await admin(`/rest/v1/profiles?id=eq.${M.uid}`, { method: "PATCH", body: { role: "user" } });
    try {
      expect((await rpc("approve_booking", { p_id: aBooking.id }, M.token)).status).toBe(403);
      const all = await api("/rest/v1/bookings?select=id", { token: M.token });
      expect(all.data.map((r) => r.id)).not.toContain(aBooking.id);
    } finally {
      await admin(`/rest/v1/profiles?id=eq.${M.uid}`, { method: "PATCH", body: { role: "master" } });
    }
  });
});
