// Боты салонов из секрета SALON_BOTS — разбор и проверка, без сети.
//
// Обычный ESM без зависимостей: его исполняют и Deno (_shared/server.ts —
// функции api и send-reminders), и Node (scripts/add-master.mjs,
// e2e/unit/salon-bots.spec.js).
//
// Токены ботов — секреты, поэтому лежат не в базе, а в одном секрете
// функций (Dashboard → Edge Functions → Secrets) — JSON по slug салона:
//   {
//     "main": { "client": "123:AAA…", "cabinet": "456:BBB…", "webhook_secret": "…" },
//     "anna": { "client": "789:CCC…", "webhook_secret": "…" }
//   }
//   client          — бот мини-аппа клиента: вход, вебхук, напоминания;
//   cabinet?        — бот кабинета (вход); нет — кабинет открывают ботом клиента;
//   webhook_secret? — secret_token вебхука бота клиента (api/bot); нет —
//                     у салона нет вебхука.
//
// Ошибка в одном салоне не роняет остальные: кривая запись выпадает
// целиком (её вход — 401, бот молчит), остальные работают. Тот же бот у
// двух салонов — выпадают оба: его initData подошла бы к обоим, и новый
// клиент выбрал бы салон адресом. В тексты ошибок не попадает ни токен,
// ни секрет — только slug и поле.

export const SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;
const TOKEN = /^[0-9]+:[A-Za-z0-9_-]+$/;
// Как требует Telegram у secret_token.
const SECRET = /^[A-Za-z0-9_-]{1,256}$/;
const KEYS = ["client", "cabinet", "webhook_secret"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * JSON секрета → { bots: Map<slug, { client, cabinet, webhookSecret }>, errors }.
 * cabinet и webhookSecret — "", если их нет (cabinet — и если он тот же,
 * что client). Пустая строка — пустая карта без ошибок (секрет не задан).
 */
export function parseSalonBots(raw) {
  const bots = new Map();
  const errors = [];
  const text = str(raw);
  if (!text) return { bots, errors };

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { bots, errors: ["SALON_BOTS — не JSON"] };
  }
  if (!isObj(data)) return { bots, errors: ["SALON_BOTS — JSON-объект { <slug>: { client, … } }"] };

  let n = 0;
  for (const [slug, entry] of Object.entries(data)) {
    n += 1;
    // Сам ключ не печатаем: на его месте по ошибке может оказаться токен.
    if (!SLUG.test(slug)) {
      errors.push(`запись №${n}: ключ — slug салона (a–z 0–9 -, 2–32 символа)`);
      continue;
    }
    const at = `«${slug}»`;
    if (!isObj(entry)) {
      errors.push(`${at}: объект { client, cabinet?, webhook_secret? }`);
      continue;
    }
    const bad = [];
    for (const k of Object.keys(entry)) {
      if (!KEYS.includes(k)) bad.push(`неизвестное поле «${k}» (есть: ${KEYS.join(", ")})`);
    }
    const client = str(entry.client);
    if (!TOKEN.test(client)) bad.push("client — токен бота клиента от @BotFather (123456:ABC…)");
    const cabinet = str(entry.cabinet);
    if (cabinet && !TOKEN.test(cabinet)) bad.push("cabinet — токен бота кабинета от @BotFather");
    const webhookSecret = str(entry.webhook_secret);
    if (webhookSecret && !SECRET.test(webhookSecret)) {
      bad.push("webhook_secret — 1–256 символов A–Z a–z 0–9 _ -");
    }
    if (bad.length) {
      for (const b of bad) errors.push(`${at}: ${b}`);
      continue;
    }
    bots.set(slug, { client, cabinet: cabinet === client ? "" : cabinet, webhookSecret });
  }

  // Один бот — один салон. Внутри салона client и cabinet могут совпадать.
  const owners = new Map();
  for (const [slug, b] of bots) {
    for (const token of signInTokens(b)) owners.set(token, [...(owners.get(token) ?? []), slug]);
  }
  const shared = new Map();
  for (const slugs of owners.values()) {
    if (slugs.length < 2) continue;
    for (const s of slugs) shared.set(s, [...(shared.get(s) ?? []), ...slugs.filter((o) => o !== s)]);
  }
  for (const [slug, others] of [...shared].sort(([a], [b]) => a.localeCompare(b))) {
    const list = [...new Set(others)].sort().map((s) => `«${s}»`).join(", ");
    errors.push(`«${slug}»: тот же бот, что у ${list} — у каждого салона свой`);
    bots.delete(slug);
  }

  return { bots, errors };
}

/** Токены, которыми проверяется initData салона: клиента и кабинета. */
export function signInTokens(bot) {
  return bot ? [bot.client, bot.cabinet].filter(Boolean) : [];
}

/**
 * Карта → JSON для секрета (тот же формат, что читает parseSalonBots),
 * салоны по алфавиту, пустые поля не пишутся.
 */
export function stringifySalonBots(bots) {
  const out = {};
  for (const slug of [...bots.keys()].sort()) {
    const b = bots.get(slug);
    out[slug] = { client: b.client };
    if (b.cabinet) out[slug].cabinet = b.cabinet;
    if (b.webhookSecret) out[slug].webhook_secret = b.webhookSecret;
  }
  return JSON.stringify(out, null, 2);
}
