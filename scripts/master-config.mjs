// Конфиг мастера для scripts/add-master.mjs — разбор и проверка, без сети.
//
// Обычный ESM без зависимостей, как supabase/functions/_shared/*: его гоняет
// e2e/unit/master-config.spec.js. Проверки — те же границы, что CHECK в
// supabase/schema.sql: лучше отказать здесь, понятным текстом, чем получить
// «violates check constraint» посреди записи в базу.
//
// Формат (masters/example.json):
//   slug           — салон, ?salon=<slug> в адресах мини-аппов;
//   master         — { name, username?, phone?, telegramId? };
//   bots           — { clientToken, cabinetToken?, webhookSecret? };
//   address?       — { address?, landmark?, transport?, mapUrl? };
//   workingHours?  — { mon: "10:00-19:00", …, sun: null };
//   workingHoursText?;
//   booking?       — { slotStepMinutes?, bookingDaysAhead?, minLeadMinutes?, reminderHours? };
//   services?      — [{ id, name, price, duration, emoji?, note?, sort?, active? }];
//   telegram?      — { appUrl?, webhookUrl? }.
// Необязательное, чего нет в конфиге, при повторном запуске не трогается.

export const SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;
const TOKEN = /^[0-9]+:[A-Za-z0-9_-]+$/;
const SECRET = /^[A-Za-z0-9_-]{1,256}$/;
const USERNAME = /^[A-Za-z0-9_]{0,32}$/;
const SERVICE_ID = /^[a-z][a-z0-9_]{1,31}$/;
const HOURS = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/;
const HTTPS = /^https:\/\/\S+$/i;

// settings_slot_step_minutes_check в schema.sql.
const SLOT_STEPS = [5, 10, 15, 20, 30, 60];
// 0 = воскресенье … 6 = суббота, как working_hours в базе.
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const TOP_KEYS = [
  "slug", "master", "bots", "address", "workingHours", "workingHoursText",
  "booking", "services", "telegram",
];

/** Пн–Пт 10–19, сб–вс выходные — для нового салона без workingHours. */
export const DEFAULT_WORKING_HOURS = {
  0: null,
  1: { from: "10:00", to: "19:00" },
  2: { from: "10:00", to: "19:00" },
  3: { from: "10:00", to: "19:00" },
  4: { from: "10:00", to: "19:00" },
  5: { from: "10:00", to: "19:00" },
  6: null,
};

/** Как в сиде schema.sql — лист ожидания. */
export const DEFAULT_TIME_OF_DAY = [
  { id: "morning", label: "Утро (10:00–13:00)" },
  { id: "afternoon", label: "День (13:00–17:00)" },
  { id: "evening", label: "Вечер (17:00–20:00)" },
  { id: "any", label: "Любое время" },
];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/**
 * Разбор конфига. → { errors: string[], plan }; при ошибках plan = null.
 * plan:
 *   slug, telegramId (или null),
 *   bots:     { client, cabinet (или null — тот же бот), webhookSecret (или null) },
 *   settings: колонки settings, которые есть в конфиге (master_name всегда),
 *   services: строки services без salon_id,
 *   telegram: { appUrl, webhookUrl } (пустые строки — шаг пропускается).
 */
export function parseMasterConfig(cfg) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!isObj(cfg)) return { errors: ["Конфиг — JSON-объект"], plan: null };

  for (const k of Object.keys(cfg)) {
    if (!TOP_KEYS.includes(k)) err(`Неизвестное поле «${k}» (есть: ${TOP_KEYS.join(", ")})`);
  }

  const slug = str(cfg.slug);
  if (typeof slug !== "string" || !SLUG.test(slug)) {
    err("slug — 2–32 символа: a–z, 0–9 и «-», с буквы или цифры");
  }

  // ─── Мастер ───
  const master = isObj(cfg.master) ? cfg.master : {};
  if (!isObj(cfg.master)) err("master — объект { name, username?, phone?, telegramId? }");
  const settings = {};
  const name = str(master.name);
  if (typeof name !== "string" || name.length < 1 || name.length > 40) {
    err("master.name — от 1 до 40 символов");
  } else settings.master_name = name;
  if (master.username !== undefined) {
    const u = String(master.username ?? "").trim().replace(/^@+/, "");
    if (!USERNAME.test(u)) err("master.username — латиница, цифры и «_», до 32 символов");
    else settings.master_username = u;
  }
  if (master.phone !== undefined) settings.master_phone = String(master.phone ?? "").trim();
  let telegramId = null;
  if (master.telegramId !== undefined && master.telegramId !== null) {
    if (!Number.isSafeInteger(master.telegramId) || master.telegramId <= 0) {
      err("master.telegramId — числовой Telegram id (узнать у @userinfobot)");
    } else telegramId = master.telegramId;
  }

  // ─── Боты ───
  const bots = isObj(cfg.bots) ? cfg.bots : {};
  if (!isObj(cfg.bots)) err("bots — объект { clientToken, cabinetToken?, webhookSecret? }");
  const client = str(bots.clientToken);
  if (typeof client !== "string" || !TOKEN.test(client)) {
    err("bots.clientToken — токен бота клиента от @BotFather (123456:ABC…)");
  }
  let cabinet = null;
  if (bots.cabinetToken !== undefined && bots.cabinetToken !== null && bots.cabinetToken !== "") {
    cabinet = str(bots.cabinetToken);
    if (!TOKEN.test(cabinet)) err("bots.cabinetToken — токен бота кабинета от @BotFather");
  }
  let webhookSecret = null;
  if (bots.webhookSecret !== undefined && bots.webhookSecret !== null && bots.webhookSecret !== "") {
    webhookSecret = str(bots.webhookSecret);
    if (!SECRET.test(webhookSecret)) err("bots.webhookSecret — 1–256 символов A–Z a–z 0–9 _ -");
  }

  // ─── Адрес ───
  if (cfg.address !== undefined) {
    if (!isObj(cfg.address)) err("address — объект { address?, landmark?, transport?, mapUrl? }");
    else {
      const a = cfg.address;
      for (const key of ["address", "landmark", "transport"]) {
        if (a[key] !== undefined) settings[key] = String(a[key] ?? "").trim();
      }
      if (a.mapUrl !== undefined) {
        const url = String(a.mapUrl ?? "").trim();
        if (url && !HTTPS.test(url)) err("address.mapUrl — ссылка https://");
        else settings.map_url = url;
      }
    }
  }

  // ─── График ───
  if (cfg.workingHours !== undefined) {
    const wh = parseWorkingHours(cfg.workingHours, err);
    if (wh) settings.working_hours = wh;
  }
  if (cfg.workingHoursText !== undefined) {
    settings.working_hours_text = String(cfg.workingHoursText ?? "").trim();
  }

  // ─── Правила записи ───
  if (cfg.booking !== undefined) {
    if (!isObj(cfg.booking)) err("booking — объект");
    else {
      const b = cfg.booking;
      if (b.slotStepMinutes !== undefined) {
        if (!SLOT_STEPS.includes(b.slotStepMinutes)) {
          err(`booking.slotStepMinutes — одно из: ${SLOT_STEPS.join(", ")}`);
        } else settings.slot_step_minutes = b.slotStepMinutes;
      }
      if (b.bookingDaysAhead !== undefined) {
        if (!isInt(b.bookingDaysAhead, 1, 60)) err("booking.bookingDaysAhead — от 1 до 60 дней");
        else settings.booking_days_ahead = b.bookingDaysAhead;
      }
      if (b.minLeadMinutes !== undefined) {
        if (!isInt(b.minLeadMinutes, 0, 10080)) err("booking.minLeadMinutes — от 0 до 10080 минут");
        else settings.min_lead_minutes = b.minLeadMinutes;
      }
      if (b.reminderHours !== undefined) {
        if (!isInt(b.reminderHours, 0, 72)) err("booking.reminderHours — от 0 до 72 часов");
        else settings.reminder_hours = b.reminderHours;
      }
    }
  }

  // ─── Услуги ───
  const services = [];
  if (cfg.services !== undefined) {
    if (!Array.isArray(cfg.services)) err("services — массив");
    else {
      const seen = new Set();
      cfg.services.forEach((s, i) => {
        const at = `services[${i}]`;
        if (!isObj(s)) return err(`${at} — объект`);
        const row = {};
        if (typeof s.id !== "string" || !SERVICE_ID.test(s.id)) {
          err(`${at}.id — 2–32 символа a–z 0–9 _, с буквы (например manicure)`);
        } else if (seen.has(s.id)) err(`${at}.id «${s.id}» повторяется`);
        else seen.add((row.id = s.id));
        const n = str(s.name);
        if (typeof n !== "string" || n.length < 1 || n.length > 80) err(`${at}.name — от 1 до 80 символов`);
        else row.name = n;
        // Та же граница, что services_price_check и validateServiceFields() кабинета.
        if (!isInt(s.price, 0, 99999)) err(`${at}.price — целые рубли, от 0 до 99 999`);
        else row.price = s.price;
        if (!isInt(s.duration, 5, 600) || s.duration % 5 !== 0) {
          err(`${at}.duration — от 5 до 600 минут, кратно 5`);
        } else row.duration = s.duration;
        if (s.emoji !== undefined) row.emoji = String(s.emoji);
        if (s.note !== undefined) row.note = String(s.note ?? "").trim();
        row.sort = Number.isInteger(s.sort) ? s.sort : (i + 1) * 10;
        if (s.active !== undefined) row.active = s.active !== false;
        services.push(row);
      });
    }
  }

  // ─── Telegram ───
  const telegram = { appUrl: "", webhookUrl: "" };
  if (cfg.telegram !== undefined) {
    if (!isObj(cfg.telegram)) err("telegram — объект { appUrl?, webhookUrl? }");
    else {
      for (const key of ["appUrl", "webhookUrl"]) {
        const v = String(cfg.telegram[key] ?? "").trim();
        if (v && !HTTPS.test(v)) err(`telegram.${key} — адрес https://`);
        else telegram[key] = v;
      }
    }
  }

  if (errors.length) return { errors, plan: null };
  return {
    errors,
    plan: {
      slug,
      telegramId,
      bots: { client, cabinet: cabinet && cabinet !== client ? cabinet : null, webhookSecret },
      settings,
      services,
      telegram,
    },
  };
}

/** { mon: "10:00-19:00", sun: null } → { 0: null, 1: { from, to }, … }; дни без ключа — выходные. */
export function parseWorkingHours(input, err) {
  if (!isObj(input)) {
    err('workingHours — объект { mon: "10:00-19:00", …, sun: null }');
    return null;
  }
  const out = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
  let ok = true;
  for (const [key, value] of Object.entries(input)) {
    if (!(key in DAYS)) {
      err(`workingHours.${key} — день недели: ${Object.keys(DAYS).join(", ")}`);
      ok = false;
      continue;
    }
    if (value === null || value === "") continue;
    const m = HOURS.exec(String(value).trim());
    if (!m || !validTime(m[1]) || !validTime(m[2]) || m[1] >= m[2]) {
      err(`workingHours.${key} — «ЧЧ:ММ-ЧЧ:ММ», конец позже начала, или null (выходной)`);
      ok = false;
      continue;
    }
    out[DAYS[key]] = { from: m[1], to: m[2] };
  }
  return ok ? out : null;
}

function validTime(t) {
  const [h, m] = t.split(":").map(Number);
  return h <= 23 && m <= 59;
}

/** Адрес мини-аппа салона с ?salon=<slug>; cabinet — admin.html рядом. */
export function salonAppUrl(appUrl, slug, { cabinet = false } = {}) {
  const url = new URL(appUrl);
  if (cabinet) url.pathname = url.pathname.replace(/\/?(index\.html)?$/, "/admin.html");
  url.searchParams.set("salon", slug);
  return url.toString();
}
