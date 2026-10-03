// Edge Function telegram-auth — вход через Telegram Mini App.
//
// POST { initData } → проверка подписи токеном бота (_shared/telegram-init-data.js)
// → аккаунт по Telegram user id (найти или завести) → обычная сессия
// Supabase { access_token, refresh_token, … }. Дальше всё как раньше:
// PostgREST, RLS и auth.uid() — граница безопасности; функция только
// решает, КТО вошёл.
//
// Что функция НЕ принимает: роль, id пользователя, имя — из тела берутся
// ровно initData и consent (редакция политики ПДн, с которой клиент
// согласился; без согласия — 403 consent_required, см. public.consents),
// остальное игнорируется. Роль не пишет никогда: строку
// profiles заводит с 'user' по умолчанию, а существующую не трогает
// (мастера назначают руками, см. is_master() в schema.sql).
//
// Сессия выпускается штатным механизмом Auth, без своего JWT: admin
// generateLink (magic link, письмо не уходит) → verifyOtp по hashed_token.
// Аккаунты — с синтетическим e-mail tg<id>@<AUTH_EMAIL_DOMAIN> и без
// пароля: войти иначе, чем через эту функцию, нельзя.
//
// Секреты (Dashboard → Edge Functions → Secrets / `supabase secrets set`):
//   TELEGRAM_CLIENT_BOT_TOKEN   — бот мини-аппа клиента;
//   TELEGRAM_CABINET_BOT_TOKEN  — бот кабинета мастера (может совпадать);
//   INITDATA_MAX_AGE_SECONDS    — необязательно, по умолчанию 3600;
//   AUTH_EMAIL_DOMAIN           — необязательно, по умолчанию telegram.local.
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY Supabase
// подставляет сам. Ни один из них не попадает в ответ.
//
// В логи не пишется ни initData, ни токены, ни e-mail — только коды ошибок.
//
// Деплой — без проверки JWT (вызывается ДО появления сессии):
//   supabase functions deploy telegram-auth --no-verify-jwt
// (локально то же задаёт supabase/config.toml).

import { createClient } from "npm:@supabase/supabase-js@2";
import { POLICY_VERSION } from "../_shared/consent.js";
import { validateInitData } from "../_shared/telegram-init-data.js";

const env = (name: string) => Deno.env.get(name)?.trim() ?? "";

const SUPABASE_URL = env("SUPABASE_URL");
const ANON_KEY = env("SUPABASE_ANON_KEY");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const BOT_TOKENS = [env("TELEGRAM_CLIENT_BOT_TOKEN"), env("TELEGRAM_CABINET_BOT_TOKEN")].filter(Boolean);
const MAX_AGE = Number(env("INITDATA_MAX_AGE_SECONDS")) || 3600;
const EMAIL_DOMAIN = env("AUTH_EMAIL_DOMAIN") || "telegram.local";

// Ответ несёт токены, но не по cookie: ни один «чужой» сайт не получит
// их, не имея initData, а с initData он обошёлся бы и без браузера.
// Поэтому CORS открыт — как у остальных эндпоинтов Supabase.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: NO_SESSION });

type TgUser = { id: number; username: string; firstName: string; lastName: string };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

class Failure extends Error {}
const must = (what: string, error: { code?: string; message?: string } | null) => {
  if (error) throw new Failure(`${what}: ${error.code ?? error.message ?? "error"}`);
};

/** Подпись подошла к одному из ботов — пользователь; иначе причина отказа. */
async function verify(initData: string): Promise<{ user?: TgUser; expired?: boolean }> {
  let expired = false;
  for (const token of BOT_TOKENS) {
    const res = await validateInitData(initData, token, { maxAgeSeconds: MAX_AGE });
    if (res.ok) return { user: res.user };
    // «Устарело» говорим, только если подпись верна (validateInitData
    // проверяет подпись первой) — иначе это просто «неверные данные».
    if (res.reason === "expired") expired = true;
  }
  return { expired };
}

/**
 * id аккаунта для Telegram user id. Единственный ключ — telegram_id
 * (уникальный): один и тот же человек с телефона и с десктопа попадает в
 * одну строку. Новому — auth-пользователь без пароля и profiles с ролью
 * по умолчанию ('user').
 */
async function findOrCreateUser(tg: TgUser): Promise<string> {
  const found = await admin.from("profiles").select("id").eq("telegram_id", tg.id).maybeSingle();
  must("profiles.select", found.error);
  if (found.data) return found.data.id;

  const email = `tg${tg.id}@${EMAIL_DOMAIN}`;
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { telegram_id: tg.id },
  });
  let id = created.data?.user?.id;
  let ours = Boolean(id);
  if (!id) {
    // Пользователь с этим e-mail уже есть: параллельный первый вход с
    // другого устройства или прошлый вход упал между createUser и
    // profiles. generateLink вернёт его id, ничего не отправляя.
    if (created.error?.code !== "email_exists") must("createUser", created.error);
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    must("generateLink", link.error);
    // Чужого пользователя с этим e-mail не подхватываем: только того, кого
    // завела сама функция (telegram_id в app_metadata пишет только service
    // role). Иначе аккаунт, заведённый заранее с адресом tg<id>@… (открытая
    // регистрация, ручная ошибка), получил бы чужой Telegram id.
    if (link.data.user.app_metadata?.telegram_id !== tg.id) {
      throw new Failure("email taken by a non-telegram user");
    }
    id = link.data.user.id;
    ours = false;
  }

  // role не передаётся — default 'user'. ignoreDuplicates — ON CONFLICT
  // DO NOTHING по id: строку, которая уже есть, не трогаем.
  const ins = await admin
    .from("profiles")
    .upsert({ id, telegram_id: tg.id }, { onConflict: "id", ignoreDuplicates: true });
  // 23505 по telegram_id — параллельный вход успел завести строку
  // раньше; ниже читаем победителя.
  if (ins.error && ins.error.code !== "23505") must("profiles.insert", ins.error);

  const winner = await admin.from("profiles").select("id").eq("telegram_id", tg.id).single();
  must("profiles.reselect", winner.error);
  if (winner.data.id !== id && ours) {
    // Проиграли гонку — свой лишний auth-пользователь не оставляем.
    await admin.auth.admin.deleteUser(id);
  }
  return winner.data.id;
}

/**
 * Согласие на обработку ПДн (152-ФЗ): есть ли строка на текущую редакцию
 * политики. Без неё функция не заводит аккаунт и не пишет ничего —
 * клиент показывает экран согласия и повторяет вход с { consent }.
 */
async function hasConsent(telegramId: number): Promise<boolean> {
  const got = await admin
    .from("consents")
    .select("telegram_id")
    .eq("telegram_id", telegramId)
    .eq("version", POLICY_VERSION)
    .maybeSingle();
  must("consents.select", got.error);
  return Boolean(got.data);
}

/** Повторное согласие на ту же редакцию — не ошибка, дата первого остаётся. */
async function recordConsent(telegramId: number) {
  const ins = await admin
    .from("consents")
    .upsert(
      { telegram_id: telegramId, version: POLICY_VERSION },
      { onConflict: "telegram_id,version", ignoreDuplicates: true },
    );
  must("consents.insert", ins.error);
}

/** Обычная сессия Supabase для аккаунта — штатными средствами Auth. */
async function mintSession(userId: string, tg: TgUser) {
  const got = await admin.auth.admin.getUserById(userId);
  must("getUserById", got.error);
  const user = got.data.user;
  // telegram_id в app_metadata — то, что проверяет is_telegram_user() в
  // базе. Пишется только здесь (service role): пользователь его не меняет.
  if (user.app_metadata?.telegram_id !== tg.id) {
    const upd = await admin.auth.admin.updateUserById(userId, {
      app_metadata: { ...user.app_metadata, telegram_id: tg.id },
    });
    must("updateUserById", upd.error);
  }
  if (!user.email) throw new Failure("user without email");

  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: user.email });
  must("generateLink", link.error);
  if (link.data.user.id !== userId) throw new Failure("link user mismatch");

  // Отдельный клиент на каждый вызов: verifyOtp кладёт сессию в клиента,
  // и общий экземпляр мог бы отдать её чужому параллельному запросу.
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: NO_SESSION });
  const verified = await anon.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.data.properties.hashed_token,
  });
  must("verifyOtp", verified.error);
  const s = verified.data.session;
  if (!s) throw new Failure("no session");
  return {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_in: s.expires_in,
    expires_at: s.expires_at,
    token_type: s.token_type,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (BOT_TOKENS.length === 0 || !SERVICE_KEY || !ANON_KEY) {
    console.error("telegram-auth: not configured");
    return json(500, { error: "not_configured" });
  }

  let initData = "";
  // Редакция политики, с которой клиент только что согласился на экране
  // согласия. Чужая (устаревший бандл) — не согласие на текущую.
  let consent = "";
  try {
    const body = await req.json();
    if (typeof body?.initData === "string") initData = body.initData;
    if (typeof body?.consent === "string") consent = body.consent;
  } catch {
    // пустое или не-JSON тело — то же, что неверные данные
  }

  const { user, expired } = await verify(initData);
  if (!user) return json(401, { error: expired ? "expired" : "invalid_init_data" });

  try {
    // Согласие — до любой записи о человеке (152-ФЗ, ст. 9): без него ни
    // auth.users, ни profiles не заводятся, а прежний аккаунт не входит,
    // пока не согласится с новой редакцией.
    if (consent === POLICY_VERSION) await recordConsent(user.id);
    else if (!(await hasConsent(user.id))) {
      return json(403, { error: "consent_required", version: POLICY_VERSION });
    }

    const userId = await findOrCreateUser(user);
    const session = await mintSession(userId, user);
    // Имя и юзернейм — из проверенного initData; роль не трогаем.
    const upd = await admin
      .from("profiles")
      .update({
        telegram_username: user.username,
        first_name: user.firstName,
        last_name: user.lastName,
        last_login_at: new Date().toISOString(),
      })
      .eq("id", userId);
    must("profiles.update", upd.error);
    return json(200, session);
  } catch (e) {
    console.error("telegram-auth:", e instanceof Failure ? e.message : "unexpected error");
    return json(500, { error: "server_error" });
  }
});
