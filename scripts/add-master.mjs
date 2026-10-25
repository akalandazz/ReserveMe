// Добавить мастера (салон) по конфигу — запускается вручную:
//
//   SUPABASE_URL=https://<проект>.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
//   npm run add-master -- masters/anna.json [--dry-run]
//
// Конфиг — masters/example.json (разбор и проверки — scripts/master-config.mjs).
// Шаги, и каждый можно повторить — запуск идемпотентен, правьте конфиг и
// запускайте снова:
//   1. салон (public.salons) по slug — найти или завести;
//   2. боты салона (public.salon_bots); токен бота, уже занятого другим
//      салоном, не принимается — иначе его initData открывал бы оба салона;
//   3. настройки (settings): новый салон — с графиком по умолчанию, уже
//      существующий — только поля, которые есть в конфиге;
//   4. услуги из конфига (по id; остальные услуги салона не трогаются);
//   5. роль мастера: если master.telegramId уже входил в ЭТОТ салон. Нет —
//      мастер открывает свой кабинет (увидит «Нет доступа»), запуск ещё раз;
//   6. Telegram, если в конфиге есть адреса: кнопка меню ботов на мини-апп
//      салона (telegram.appUrl) и вебхук бота клиента с описанием и командами
//      (telegram.webhookUrl — …/functions/v1/client-bot).
//
// Service-role ключ — только из окружения, в конфиг не пишется. Конфиг
// с токенами ботов — тоже секрет: masters/*.json в .gitignore. В вывод не
// попадает ни один токен.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import {
  BOT_COMMANDS,
  BOT_DESCRIPTION,
  BOT_SHORT_DESCRIPTION,
} from "../supabase/functions/_shared/client-bot.js";
import {
  DEFAULT_TIME_OF_DAY,
  DEFAULT_WORKING_HOURS,
  parseMasterConfig,
  salonAppUrl,
} from "./master-config.mjs";

const env = (name) => process.env[name]?.trim() ?? "";
const API_URL = (env("TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/$/, "");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--"));

/** Остановка с понятным текстом. Не process.exit(): у supabase-js ещё открыты
 *  сокеты, и выход посреди них роняет Node на Windows (UV_HANDLE_CLOSING). */
class Fail extends Error {}
function fail(message) {
  throw new Fail(message);
}

const ok = (message) => console.log(`✓ ${message}`);
const note = (message) => console.log(`  ${message}`);

/** Логин бота по токену (getMe) или "": без него мастер укажет логин сама. */
async function botUsername(token) {
  try {
    const res = await fetch(`${API_URL}/bot${token}/getMe`);
    const json = await res.json();
    return json.ok && typeof json.result?.username === "string" ? json.result.username : "";
  } catch {
    return "";
  }
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Fail ? e.message : e?.stack ?? e}`);
  process.exitCode = 1;
});

async function main() {
  if (!file) fail("Укажите конфиг: npm run add-master -- masters/<имя>.json [--dry-run]");

  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    fail(`${file}: ${e.code === "ENOENT" ? "файл не найден" : `не JSON (${e.message})`}`);
  }

  const { errors, plan } = parseMasterConfig(raw);
  if (errors.length) fail(`${file}: ошибки в конфиге\n${errors.map((e) => `  • ${e}`).join("\n")}`);

  if (dryRun) {
    const telegramSteps = [plan.telegram.appUrl && "кнопка меню", plan.telegram.webhookUrl && "вебхук"];
    ok(`${file}: конфиг в порядке (--dry-run — в базу ничего не пишется)`);
    note(`салон: ${plan.slug}, мастер: ${plan.settings.master_name}`);
    note(`боты: клиента${plan.bots.cabinet ? " + кабинета" : " (он же кабинет)"}`);
    note(`настройки: ${Object.keys(plan.settings).join(", ")}`);
    note(`услуги: ${plan.services.map((s) => s.id).join(", ") || "—"}`);
    note(`роль мастера: ${plan.telegramId ? `Telegram id ${plan.telegramId}` : "— (нет master.telegramId)"}`);
    note(`Telegram: ${telegramSteps.filter(Boolean).join(", ") || "—"}`);
    return;
  }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!/^https?:\/\//.test(SUPABASE_URL) || !SERVICE_KEY) {
    fail("Нужны SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в окружении (Dashboard → Project Settings → API).");
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  /** Результат запроса или выход с понятной ошибкой. */
  async function must(what, query) {
    const { data, error } = await query;
    if (error) fail(`${what}: ${error.message}${error.details ? ` (${error.details})` : ""}`);
    return data;
  }

  // ─── 1. Салон ───────────────────────────────────────────────────
  let salon = await must(
    "salons",
    db.from("salons").select("id, slug").eq("slug", plan.slug).maybeSingle()
  );

  // Бот другого салона — до любой записи, чтобы отказ не оставил пустой салон.
  // (То же держит и сама база: salon_bots_one_salon_per_token.)
  const tokens = [plan.bots.client, plan.bots.cabinet].filter(Boolean);
  const taken = (
    await must("salon_bots", db.from("salon_bots").select("salon_id").in("token", tokens))
  ).filter((b) => b.salon_id !== salon?.id);
  if (taken.length) {
    fail(`бот уже подключён к другому салону (id ${taken[0].salon_id}) — у каждого мастера свой бот`);
  }

  if (salon) {
    ok(`салон «${plan.slug}» уже есть (id ${salon.id}) — обновляю`);
  } else {
    const last = await must(
      "salons",
      db.from("salons").select("id").order("id", { ascending: false }).limit(1)
    );
    const id = (last[0]?.id ?? 0) + 1;
    salon = await must(
      "salons: создание",
      db.from("salons").insert({ id, slug: plan.slug }).select("id, slug").single()
    );
    ok(`салон «${plan.slug}» создан (id ${salon.id})`);
  }

  // ─── 2. Боты ────────────────────────────────────────────────────
  const existing = await must(
    "salon_bots",
    db.from("salon_bots").select("kind, webhook_secret").eq("salon_id", salon.id)
  );
  // Секрет вебхука: из конфига, иначе прежний (вебхук уже настроен на него),
  // иначе новый.
  const webhookSecret =
    plan.bots.webhookSecret ||
    existing.find((b) => b.kind === "client")?.webhook_secret ||
    randomBytes(32).toString("base64url");
  const botRows = [
    { salon_id: salon.id, kind: "client", token: plan.bots.client, webhook_secret: webhookSecret },
  ];
  if (plan.bots.cabinet) {
    botRows.push({ salon_id: salon.id, kind: "cabinet", token: plan.bots.cabinet, webhook_secret: "" });
  }
  await must("salon_bots: запись", db.from("salon_bots").upsert(botRows, { onConflict: "salon_id,kind" }));
  ok(`боты: клиента${plan.bots.cabinet ? " и кабинета" : " (он же бот кабинета)"}`);

  // ─── 3. Настройки ───────────────────────────────────────────────
  const hasSettings = await must(
    "settings",
    db.from("settings").select("salon_id, client_bot_username").eq("salon_id", salon.id).maybeSingle()
  );
  // Логин бота клиента (settings.client_bot_username) — для ссылки-
  // приглашения t.me/<бот>?start=c_<код>. Только если его ещё нет.
  const settings = { ...plan.settings };
  if (!hasSettings?.client_bot_username) {
    const botName = await botUsername(plan.bots.client);
    if (botName) settings.client_bot_username = botName;
    else note("логин бота клиента не получен (getMe) — мастер укажет его в «Настройках»");
  }
  if (hasSettings) {
    await must("settings: обновление", db.from("settings").update(settings).eq("salon_id", salon.id));
    ok(`настройки обновлены: ${Object.keys(settings).join(", ")}`);
  } else {
    await must(
      "settings: создание",
      db.from("settings").insert({
        salon_id: salon.id,
        working_hours: DEFAULT_WORKING_HOURS,
        time_of_day: DEFAULT_TIME_OF_DAY,
        ...settings,
      })
    );
    ok(`настройки созданы${settings.working_hours ? "" : " (график по умолчанию: пн–пт 10–19)"}`);
  }

  // ─── 4. Услуги ──────────────────────────────────────────────────
  if (plan.services.length) {
    await must(
      "services",
      db
        .from("services")
        .upsert(plan.services.map((s) => ({ salon_id: salon.id, ...s })), { onConflict: "salon_id,id" })
    );
    ok(`услуги: ${plan.services.map((s) => s.id).join(", ")}`);
  } else {
    note("услуг в конфиге нет — мастер заведёт их в кабинете (без услуг записаться нельзя)");
  }

  // ─── 5. Роль мастера ────────────────────────────────────────────
  let roleDone = false;
  if (plan.telegramId) {
    const prof = await must(
      "profiles",
      db.from("profiles").select("id, salon_id, role").eq("telegram_id", plan.telegramId).maybeSingle()
    );
    if (!prof) {
      note(`роль: Telegram id ${plan.telegramId} ещё не входил — пусть откроет свой кабинет, затем запустите ещё раз`);
    } else if (prof.salon_id !== salon.id) {
      fail(
        `роль: аккаунт Telegram id ${plan.telegramId} уже в другом салоне (id ${prof.salon_id}) — один аккаунт, один салон`
      );
    } else {
      if (prof.role !== "master") {
        await must("profiles: роль", db.from("profiles").update({ role: "master" }).eq("id", prof.id));
      }
      ok("роль мастера выдана");
      roleDone = true;
    }
  } else {
    note("роль: нет master.telegramId — укажите его и запустите ещё раз после первого входа мастера");
  }

  // ─── 6. Telegram ────────────────────────────────────────────────
  async function bot(token, method, body) {
    let res;
    try {
      res = await fetch(`${API_URL}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      fail(`Telegram ${method}: нет связи`);
    }
    const json = await res.json().catch(() => ({}));
    if (!json.ok) fail(`Telegram ${method}: ${json.description ?? res.status}`);
  }

  const clientUrl = plan.telegram.appUrl ? salonAppUrl(plan.telegram.appUrl, plan.slug) : "";
  const cabinetUrl = plan.telegram.appUrl
    ? salonAppUrl(plan.telegram.appUrl, plan.slug, { cabinet: true })
    : "";

  if (clientUrl) {
    await bot(plan.bots.client, "setChatMenuButton", {
      menu_button: { type: "web_app", text: "Записаться", web_app: { url: clientUrl } },
    });
    ok("бот клиента: кнопка меню «Записаться»");
    if (plan.bots.cabinet) {
      await bot(plan.bots.cabinet, "setChatMenuButton", {
        menu_button: { type: "web_app", text: "Кабинет", web_app: { url: cabinetUrl } },
      });
      ok("бот кабинета: кнопка меню «Кабинет»");
    }
  }

  if (plan.telegram.webhookUrl) {
    const hook = new URL(plan.telegram.webhookUrl);
    hook.searchParams.set("salon", plan.slug);
    // Без language_code — для всех языков интерфейса, как setup-client-bot.mjs.
    await bot(plan.bots.client, "setMyDescription", { description: BOT_DESCRIPTION });
    await bot(plan.bots.client, "setMyShortDescription", { short_description: BOT_SHORT_DESCRIPTION });
    await bot(plan.bots.client, "setMyCommands", { commands: BOT_COMMANDS });
    await bot(plan.bots.client, "setWebhook", {
      url: hook.toString(),
      secret_token: webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    ok("бот клиента: описание, команды и вебхук");
  }

  // ─── Итог ───────────────────────────────────────────────────────
  console.log("");
  ok(`мастер «${plan.settings.master_name}» — салон «${plan.slug}» (id ${salon.id})`);
  if (clientUrl) {
    note(`мини-апп клиента: ${clientUrl}`);
    note(`кабинет:          ${cabinetUrl}${plan.bots.cabinet ? "" : "  (один бот — открывать по этой ссылке)"}`);
    note("тот же адрес можно задать и в @BotFather → Bot Settings → Configure Mini App");
  } else {
    note(`telegram.appUrl не задан — адреса мини-аппов в @BotFather задайте сами, с ?salon=${plan.slug}`);
  }
  if (!roleDone) note("осталось: мастер открывает кабинет → запуск ещё раз (выдаст роль)");
}
