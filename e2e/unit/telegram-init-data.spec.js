import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { validateInitData } from "../../supabase/functions/_shared/telegram-init-data.js";

// Проверка подписи initData (supabase/functions/_shared/telegram-init-data.js)
// — та же функция, что исполняет Edge Function telegram-auth. Без браузера.
//
// Подписываем здесь СВОИМ кодом (node:crypto), по документации Telegram, а
// не через проверяемый модуль: иначе ошибка в алгоритме подписала бы и
// проверила сама себя. Токен, время и пользователь — фиксированные.

const BOT_TOKEN = "123456:TEST-bot-token-not-real";
const OTHER_BOT_TOKEN = "654321:another-bot-token";
const NOW = 1_790_000_000; // фиксированное «сейчас», секунды Unix
const MAX_AGE = 3600;
const USER = { id: 4242424242, first_name: "Анна", last_name: "Тест", username: "anna_tg" };

/** initData, подписанный как это делает Telegram. */
function sign(fields, token = BOT_TOKEN) {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const fields = (over = {}) => ({
  auth_date: String(NOW - 60),
  query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
  user: JSON.stringify(USER),
  signature: "c2lnbmF0dXJlLXZhbHVl", // поле Ed25519 — подписывается HMAC как обычное
  ...over,
});

const check = (initData, token = BOT_TOKEN, now = NOW) =>
  validateInitData(initData, token, { maxAgeSeconds: MAX_AGE, now });

test("подписанный initData — пользователь из подписанного поля user", async () => {
  const res = await check(sign(fields()));
  expect(res).toEqual({
    ok: true,
    authDate: NOW - 60,
    user: { id: USER.id, username: "anna_tg", firstName: "Анна", lastName: "Тест" },
  });
});

test("подменённое поле — неверная подпись", async () => {
  const good = new URLSearchParams(sign(fields()));
  good.set("user", JSON.stringify({ ...USER, id: 1 })); // чужой id
  expect(await check(good.toString())).toEqual({ ok: false, reason: "bad_signature" });
});

test("добавленное поле — неверная подпись", async () => {
  const good = new URLSearchParams(sign(fields()));
  good.set("role", "master");
  expect(await check(good.toString())).toEqual({ ok: false, reason: "bad_signature" });
});

test("hash от другого бота — неверная подпись", async () => {
  expect(await check(sign(fields(), OTHER_BOT_TOKEN))).toEqual({ ok: false, reason: "bad_signature" });
});

test("произвольный hash — неверная подпись", async () => {
  const good = new URLSearchParams(sign(fields()));
  good.set("hash", "0".repeat(64));
  expect(await check(good.toString())).toEqual({ ok: false, reason: "bad_signature" });
  good.set("hash", "not-hex");
  expect(await check(good.toString())).toEqual({ ok: false, reason: "bad_signature" });
});

test("без hash, пустой, не строка, слишком длинный — malformed", async () => {
  const noHash = new URLSearchParams(sign(fields()));
  noHash.delete("hash");
  expect(await check(noHash.toString())).toEqual({ ok: false, reason: "malformed" });
  expect(await check("")).toEqual({ ok: false, reason: "malformed" });
  expect(await check(undefined)).toEqual({ ok: false, reason: "malformed" });
  expect(await check({ user: USER })).toEqual({ ok: false, reason: "malformed" });
  expect(await check("a=".padEnd(5000, "x"))).toEqual({ ok: false, reason: "malformed" });
});

test("повторённый ключ — malformed, даже если одна из копий подписана", async () => {
  const forged = `${sign(fields())}&user=${encodeURIComponent(JSON.stringify({ id: 1 }))}`;
  expect(await check(forged)).toEqual({ ok: false, reason: "malformed" });
});

test("без токена бота ничего не проходит", async () => {
  expect(await check(sign(fields()), "")).toEqual({ ok: false, reason: "bad_signature" });
});

test("устаревший auth_date — expired", async () => {
  const stale = sign(fields({ auth_date: String(NOW - MAX_AGE - 1) }));
  expect(await check(stale)).toEqual({ ok: false, reason: "expired" });
  // Ровно на границе — ещё годен.
  const edge = sign(fields({ auth_date: String(NOW - MAX_AGE) }));
  expect((await check(edge)).ok).toBe(true);
});

test("auth_date из будущего (больше допуска часов) — malformed", async () => {
  expect(await check(sign(fields({ auth_date: String(NOW + 3600) })))).toEqual({
    ok: false,
    reason: "malformed",
  });
  expect((await check(sign(fields({ auth_date: String(NOW + 30) })))).ok).toBe(true);
});

test("auth_date не число — malformed", async () => {
  expect(await check(sign(fields({ auth_date: "yesterday" })))).toEqual({ ok: false, reason: "malformed" });
});

test("подписанный, но без пользователя или с кривым id — no_user", async () => {
  const noUser = fields();
  delete noUser.user;
  expect(await check(sign(noUser))).toEqual({ ok: false, reason: "no_user" });
  expect(await check(sign(fields({ user: "{not json" })))).toEqual({ ok: false, reason: "no_user" });
  expect(await check(sign(fields({ user: JSON.stringify({ id: "42" }) })))).toEqual({
    ok: false,
    reason: "no_user",
  });
  expect(await check(sign(fields({ user: JSON.stringify({ id: -5 }) })))).toEqual({
    ok: false,
    reason: "no_user",
  });
});

test("сортировка по ключу, а не по строке «key=value»", async () => {
  // "a" < "a1" по ключу, но "a1=…" < "a=…" по строке ('1' < '=').
  const res = await check(sign(fields({ a: "x", a1: "y" })));
  expect(res.ok).toBe(true);
});

test("лишние поля пользователя (роль и т.п.) не попадают в результат", async () => {
  const res = await check(sign(fields({ user: JSON.stringify({ ...USER, role: "master" }) })));
  expect(res.ok).toBe(true);
  expect(res.user).not.toHaveProperty("role");
});
