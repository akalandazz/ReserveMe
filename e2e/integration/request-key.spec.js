import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  ENABLED,
  LOCAL_ONLY,
  api,
  asRow,
  insertBooking,
  signIn,
  tgUser,
  wipeBookings,
  workdays,
} from "./support.js";

// Повтор заявки (bookings.request_key, индекс bookings_user_request_uq в
// schema.sql): ответ на вставку потерялся, клиент жмёт «Повторить» — тот же
// ключ второй строки не создаёт (23505 → 409), и клиент читает уже
// сохранённую по ключу. Это и были «несколько записей от одного человека».

test.skip(!ENABLED, "нет SUPABASE_IT_* — локальный Supabase не поднят (см. support.js)");
test.skip(ENABLED && !LOCAL_ONLY, "SUPABASE_IT_URL должен указывать на локальный стек");

const DAY = workdays()[1];
let A, B;

test.beforeAll(async () => {
  await wipeBookings();
  A = await signIn(tgUser("rk-a"));
  B = await signIn(tgUser("rk-b"));
});

const request = (who, request_key, start_min = 600) =>
  insertBooking(who.token, { day: DAY, start_min, services: [{ id: "manicure" }], request_key });

test("тот же ключ дважды — одна заявка, повтор получает 23505", async () => {
  const key = randomUUID();
  const first = await request(A, key);
  expect(first.status, JSON.stringify(first.data)).toBe(201);
  expect(asRow(first).request_key).toBe(key);

  const again = await request(A, key);
  expect(again.status).toBe(409);
  expect(again.data.code).toBe("23505");

  // Как createBooking после 23505: своя строка по ключу.
  const mine = await api(`/rest/v1/bookings?request_key=eq.${key}&select=id`, { token: A.token });
  expect(mine.data).toEqual([{ id: asRow(first).id }]);
});

test("ключ уникален в паре с аккаунтом, без ключа — как раньше", async () => {
  const key = randomUUID();
  expect((await request(A, key, 720)).status).toBe(201);
  // Чужой аккаунт с тем же ключом не мешает и чужую строку не видит.
  expect((await request(B, key, 720)).status).toBe(201);
  const seen = await api(`/rest/v1/bookings?request_key=eq.${key}&select=user_id`, { token: B.token });
  expect(seen.data).toEqual([{ user_id: B.uid }]);

  // Старый бандл ключа не шлёт — ограничения нет.
  expect((await request(A, undefined, 840)).status).toBe(201);
  expect((await request(A, undefined, 840)).status).toBe(201);
});
