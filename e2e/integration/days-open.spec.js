import { expect, test } from "@playwright/test";
import {
  ENABLED,
  LOCAL_ONLY,
  admin,
  api,
  insertBooking,
  rpc,
  signIn,
  tgUser,
  wipeBookings,
} from "./support.js";

// Разово открытый выходной (days_open) — правило hours_for_day() из
// schema.sql: заявка клиента и free_slots мастера принимают эту дату с её
// часами, а то же воскресенье неделей позже остаётся выходным по графику.

test.skip(!ENABLED, "нет SUPABASE_IT_* — локальный Supabase не поднят (см. support.js)");
test.skip(ENABLED && !LOCAL_ONLY, "SUPABASE_IT_URL должен указывать на локальный стек");

/** Воскресенья (выходной в seed schema.sql) в окне записи, по Тбилиси, с послезавтра. */
function sundays() {
  const out = [];
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tbilisi" });
  for (let i = 2; i <= 13; i++) {
    const key = fmt.format(new Date(Date.now() + i * 86_400_000));
    if (new Date(`${key}T12:00:00Z`).getUTCDay() === 0) out.push(key);
  }
  return out;
}

const [SUN, NEXT_SUN] = sundays();
const wipeDaysOpen = () => admin("/rest/v1/days_open?day=gte.1900-01-01", { method: "DELETE" });

let A, M;

test.beforeAll(async () => {
  if (!ENABLED || !LOCAL_ONLY) return;
  await wipeBookings();
  await wipeDaysOpen();
  A = await signIn(tgUser("Alice"));
  const mUser = tgUser("Master");
  await signIn(mUser);
  await admin(`/rest/v1/profiles?telegram_id=eq.${mUser.id}`, {
    method: "PATCH",
    body: { role: "master" },
  });
  M = await signIn(mUser);
});

test.afterAll(async () => {
  if (ENABLED && LOCAL_ONLY) await wipeDaysOpen();
});

test("клиент не пишет в days_open, аноним читает", async () => {
  const res = await api("/rest/v1/days_open", {
    method: "POST",
    token: A.token,
    body: { day: SUN, hours: { from: "10:00", to: "19:00" } },
  });
  expect(res.status).toBe(403);
  expect((await api("/rest/v1/days_open?select=day")).status).toBe(200);
});

test("часы — проверка таблицы: конец раньше начала не сохраняется", async () => {
  const res = await api("/rest/v1/days_open", {
    method: "POST",
    token: M.token,
    body: { day: SUN, hours: { from: "15:00", to: "12:00" } },
  });
  expect(res.status).toBe(400);
});

test("воскресенье, открытое разово, принимает заявки в своих часах; другое — нет", async () => {
  const closed = await insertBooking(A.token, { day: SUN, start_min: 720 });
  expect(closed.status).toBe(400);
  expect(closed.data.message).toBe("В этот день мастер не принимает");

  const open = await api("/rest/v1/days_open", {
    method: "POST",
    token: M.token,
    body: { day: SUN, hours: { from: "12:00", to: "15:00" } },
  });
  expect(open.status).toBe(201);

  // 12:00–15:00, маникюр 90 мин, шаг 30.
  const slots = await rpc("free_slots", { p_day: SUN, p_service_ids: ["manicure"] }, M.token);
  expect(slots.status).toBe(200);
  expect(slots.data.map((r) => r.start_min)).toEqual([720, 750, 780, 810]);

  expect((await insertBooking(A.token, { day: SUN, start_min: 720 })).status).toBe(201);
  const early = await insertBooking(A.token, { day: SUN, start_min: 600 });
  expect(early.status).toBe(400);
  expect(early.data.message).toBe("Такого времени нет в расписании");

  if (NEXT_SUN) {
    const other = await insertBooking(A.token, { day: NEXT_SUN, start_min: 720 });
    expect(other.status).toBe(400);
    expect(other.data.message).toBe("В этот день мастер не принимает");
  }
});

test("days_off сильнее days_open", async () => {
  await admin("/rest/v1/days_off", { method: "POST", body: { day: SUN, salon_id: 1 } });
  try {
    const res = await insertBooking(A.token, { day: SUN, start_min: 750 });
    expect(res.status).toBe(400);
    expect(res.data.message).toBe("В этот день мастер не принимает");
  } finally {
    await admin(`/rest/v1/days_off?day=eq.${SUN}`, { method: "DELETE" });
  }
});
