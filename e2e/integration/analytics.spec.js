import { expect, test } from "@playwright/test";
import { ENABLED, LOCAL_ONLY, admin, api, asRow, signIn, tgUser, wipeBookings } from "./support.js";

// «Аналитика» кабинета — настоящий маршрут api/analytics
// (supabase/functions/api/analytics.ts): данные читаются от имени мастера
// (RLS), считает _shared/analytics.js, «сейчас» — по Тбилиси. Здесь —
// права, суммы на настоящих строках, отмены, часы салона и чтение больше
// одной страницы PostgREST (max_rows = 1000). Салоны — tenancy.spec.js.

test.skip(!ENABLED, "нет SUPABASE_IT_* — локальный Supabase не поднят (см. support.js)");
test.skip(ENABLED && !LOCAL_ONLY, "SUPABASE_IT_URL должен указывать на локальный стек");

let M, C; // мастер и клиент салона 1

const analytics = (token, body) => api("/functions/v1/api/analytics", { method: "POST", token, body });

/** Строки bookings салона 1 от service role, мимо RPC. */
async function seed(rows) {
  const res = await admin("/rest/v1/bookings", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: rows.map((r) => ({
      start_min: 600,
      duration: 30,
      price: 100,
      service_id: "manicure",
      service_name: "Маникюр",
      status: "ok",
      source: "master",
      salon_id: 1,
      ...r,
    })),
  });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data;
}

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
  const mUser = tgUser("AnalyticsMaster");
  await signIn(mUser);
  await admin(`/rest/v1/profiles?telegram_id=eq.${mUser.id}`, { method: "PATCH", body: { role: "master" } });
  M = await signIn(mUser);
  C = await signIn(tgUser("AnalyticsClient"));
});

test.describe("права", () => {
  test("клиент — 403, anon — 403, битый JWT — 401", async () => {
    expect((await analytics(C.token, {})).status).toBe(403);
    expect((await analytics(undefined, {})).status).toBe(403);
    expect((await analytics("not-a-jwt", {})).status).toBe(401);
  });

  test("неверный период — 400", async () => {
    for (const body of [
      { from: "2021-03-31", to: "2021-03-01" },
      { from: "2021-02-30" },
      { from: "март" },
    ]) {
      expect((await analytics(M.token, body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

test.describe("суммы", () => {
  test("подтверждённые за период, отмены и заявки не в счёт, изменение к прошлому месяцу", async () => {
    const card = asRow(
      await admin("/rest/v1/clients", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: {
          salon_id: 1,
          name: "Аналитика Анна",
          telegram_username: "",
          phone: "+995 555 00 00 00",
          channel: "wa",
        },
      })
    );
    await seed([
      { day: "2021-03-05", price: 100, client_id: card.id },
      { day: "2021-03-20", start_min: 720, price: 250, client_id: card.id },
      { day: "2021-03-21", price: 999, status: "new", source: "client" },
      { day: "2021-03-22", price: 999, status: "cancelled", cancelled_by: "master" },
      { day: "2021-02-10", price: 175 },
      { day: "2021-04-01", price: 999 },
    ]);

    const res = await analytics(M.token, { from: "2021-03-01", to: "2021-03-31" });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const s = res.data.summary;
    expect(s).toMatchObject({
      earned: 350,
      expected: 0,
      total: 350,
      delta: 100,
      visitCount: 2,
      upcomingCount: 0,
      avg: 175,
      clientCount: 1,
    });
    expect(s.services).toEqual([{ id: "manicure", name: "Маникюр", visits: 2, sum: 350 }]);
    // Наружу — только контакты карточки.
    expect(s.top[0]).toMatchObject({
      visits: 2,
      sum: 350,
      lastVisit: "2021-03-20",
      client: {
        id: card.id,
        name: "Аналитика Анна",
        telegram_username: "",
        phone: "+995 555 00 00 00",
        channel: "wa",
      },
    });
    expect(Object.keys(s.top[0].client).sort()).toEqual(["channel", "id", "name", "phone", "telegram_username"]);
    expect(res.data.months).toHaveLength(6);
  });

  test("«сейчас» — по Тбилиси: до и после текущего момента", async () => {
    const before = tbilisiSlot(-2);
    const after = tbilisiSlot(2);
    await seed([
      { ...before, price: 40 },
      { ...after, price: 60 },
    ]);
    const res = await analytics(M.token, { from: before.day, to: after.day });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.now.day).toBe(tbilisiSlot(0).day);
    expect(res.data.summary).toMatchObject({ earned: 40, expected: 60, visitCount: 1, upcomingCount: 1 });
  });

  test("больше одной страницы PostgREST — все строки в счёт", async () => {
    // 1100 подтверждённых визитов по рублю, по одному в день с 2015 года
    // (ключи из Date.UTC — от часового пояса машины не зависят).
    const start = Date.UTC(2015, 0, 1);
    const rows = Array.from({ length: 1100 }, (_, i) => ({
      day: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      price: 1,
    }));
    await seed(rows);
    const res = await analytics(M.token, { from: "2015-01-01", to: "2018-12-31" });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.summary).toMatchObject({ earned: 1100, visitCount: 1100 });
  });
});
