// Проверка Telegram.WebApp.initData — подписи и свежести.
//
// Обычный ESM на Web Crypto, без зависимостей: тот же файл исполняет
// Edge Function telegram-auth (Deno) и юнит-тест e2e/unit (Node).
//
// Алгоритм — из документации Telegram («Validating data received via the
// Mini App»):
//   data_check_string = все поля, кроме hash, «key=value», отсортированные
//                       по ключу, через "\n";
//   secret_key        = HMAC_SHA256(key = "WebAppData", msg = bot_token);
//   hash              = hex(HMAC_SHA256(key = secret_key, msg = data_check_string)).
// Поле signature (Ed25519 для проверки третьими сторонами) входит в
// data_check_string как обычное поле — исключается только hash.
//
// Подпись проверяется ДО всего остального: про неподписанные данные
// ответ один — «неверные», без подсказки, какое поле не так.

const enc = new TextEncoder();

/** Длиннее initData не бывает; больше — не разбираем вовсе. */
export const MAX_INIT_DATA_LENGTH = 4096;
/** Часы Telegram и сервера могут чуть разъехаться. */
const CLOCK_SKEW_SECONDS = 60;

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Сравнение без раннего выхода — время ответа не выдаёт, сколько байт совпало. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const fail = (reason) => ({ ok: false, reason });

/**
 * @param {string} initData  Telegram.WebApp.initData как есть (query-строка).
 * @param {string} botToken  токен бота, которым открыт мини-апп.
 * @param {{ maxAgeSeconds: number, now?: number }} opts  now — секунды Unix.
 * @returns {Promise<
 *   | { ok: true, authDate: number,
 *       user: { id: number, username: string, firstName: string, lastName: string } }
 *   | { ok: false, reason: "malformed" | "bad_signature" | "expired" | "no_user" }
 * >}
 */
export async function validateInitData(initData, botToken, { maxAgeSeconds, now = Date.now() / 1000 }) {
  if (typeof initData !== "string" || initData === "" || initData.length > MAX_INIT_DATA_LENGTH) {
    return fail("malformed");
  }
  if (typeof botToken !== "string" || botToken === "") return fail("bad_signature");

  const params = new URLSearchParams(initData);
  const pairs = [];
  const keys = new Set();
  let hash = null;
  for (const [k, v] of params) {
    // Повтор ключа — подделка или мусор: какое из значений подписано,
    // а какое прочитает код ниже, не угадать.
    if (keys.has(k)) return fail("malformed");
    keys.add(k);
    if (k === "hash") hash = v;
    else pairs.push([k, v]);
  }
  if (!hash) return fail("malformed");

  // По ключу, а не по строке «key=value»: '=' (0x3D) старше цифр, и ключи
  // вида "a" и "a1" отсортировались бы иначе, чем у Telegram.
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const expected = await hmac(secret, dataCheckString);
  const got = hexToBytes(hash.toLowerCase());
  if (!got || !timingSafeEqual(expected, got)) return fail("bad_signature");

  // Дальше — только подписанные Telegram данные.
  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return fail("malformed");
  if (authDate > now + CLOCK_SKEW_SECONDS) return fail("malformed");
  if (now - authDate > maxAgeSeconds) return fail("expired");

  let user;
  try {
    user = JSON.parse(params.get("user") ?? "");
  } catch {
    return fail("no_user");
  }
  if (!user || typeof user !== "object" || !Number.isSafeInteger(user.id) || user.id <= 0) {
    return fail("no_user");
  }

  return {
    ok: true,
    authDate,
    user: {
      id: user.id,
      username: text(user.username, 64),
      firstName: text(user.first_name, 64),
      lastName: text(user.last_name, 64),
    },
  };
}
