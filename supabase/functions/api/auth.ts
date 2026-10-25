// POST /api/auth — вход через Telegram Mini App (бывшая функция telegram-auth).
//
// { initData } → проверка подписи токеном бота (_shared/telegram-init-data.js)
// → аккаунт по Telegram user id (найти или завести) → обычная сессия
// Supabase { access_token, refresh_token, … }. Дальше всё как раньше:
// PostgREST, RLS и auth.uid() — граница безопасности; маршрут только
// решает, КТО вошёл.
//
// Что НЕ принимается: роль, id пользователя, имя — из тела берутся ровно
// initData, consent (редакция политики ПДн, с которой клиент согласился;
// без согласия — 403 consent_required, см. public.consents) и salon,
// остальное игнорируется. Роль не пишется никогда: строку profiles заводим
// с 'user' по умолчанию, а существующую не трогаем (мастера назначают
// руками, см. is_master() в schema.sql).
//
// Салон (тенант, см. «Салоны» в schema.sql). salon — slug из адреса
// мини-аппа (?salon=… у бота салона в BotFather) — только подсказка, КАКИМИ
// токенами проверять подпись: берутся боты этого салона из salon_bots, и
// initData чужого бота с ними не сойдётся (401). Без salon — салон 1.
// Салон нового аккаунта — тот, чей бот подписал initData; аккаунт другого
// салона не входит — 403 other_salon (один аккаунт — один салон), и ничего
// не пишется.
//
// Сессия выпускается штатным механизмом Auth, без своего JWT: admin
// generateLink (magic link, письмо не уходит) → verifyOtp по hashed_token.
// Аккаунты — с синтетическим e-mail tg<id>@<AUTH_EMAIL_DOMAIN> и без
// пароля: войти иначе, чем здесь, нельзя.
//
// В логи не пишется ни initData, ни токены, ни e-mail — только коды ошибок.

import { createClient } from "npm:@supabase/supabase-js@2";
import { POLICY_VERSION } from "../_shared/consent.js";
import { validateInitData } from "../_shared/telegram-init-data.js";
import {
  ANON_KEY,
  CORS,
  DEFAULT_SALON,
  NO_SESSION,
  SERVICE_KEY,
  SLUG,
  SUPABASE_URL,
  admin,
  env,
  json,
} from "../_shared/server.ts";

const ENV_TOKENS = [env("TELEGRAM_CLIENT_BOT_TOKEN"), env("TELEGRAM_CABINET_BOT_TOKEN")].filter(Boolean);
const MAX_AGE = Number(env("INITDATA_MAX_AGE_SECONDS")) || 3600;
const EMAIL_DOMAIN = env("AUTH_EMAIL_DOMAIN") || "telegram.local";

type TgUser = {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  allowsWriteToPm: boolean;
};

class Failure extends Error {}
/** Аккаунт уже принадлежит другому салону — 403 other_salon. */
class OtherSalon extends Error {}
const must = (what: string, error: { code?: string; message?: string } | null) => {
  if (error) throw new Failure(`${what}: ${error.code ?? error.message ?? "error"}`);
};

/**
 * Салон и токены его ботов. slug — из тела запроса (непроверенный, но
 * решает он только то, с какими токенами сверять подпись). Пустой — салон 1;
 * неизвестный или кривой — null, то же, что неверная подпись.
 */
async function findSalon(slug: string): Promise<{ id: number; tokens: string[] } | null> {
  if (slug && !SLUG.test(slug)) return null;
  const q = admin.from("salons").select("id, salon_bots(token)");
  const res = await (slug ? q.eq("slug", slug) : q.eq("id", DEFAULT_SALON)).maybeSingle();
  must("salons.select", res.error);
  if (!res.data) return null;
  const tokens = (res.data.salon_bots ?? []).map((b: { token: string }) => b.token);
  if (res.data.id === DEFAULT_SALON) tokens.push(...ENV_TOKENS);
  return { id: res.data.id, tokens };
}

/** Подпись подошла к одному из ботов салона — пользователь; иначе причина отказа. */
async function verify(initData: string, tokens: string[]): Promise<{ user?: TgUser; expired?: boolean }> {
  let expired = false;
  for (const token of tokens) {
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
 * по умолчанию ('user') в салоне salonId. Аккаунт другого салона —
 * OtherSalon, в том числе проигравший гонку первого входа в двух салонах.
 */
async function findOrCreateUser(tg: TgUser, salonId: number): Promise<string> {
  const found = await admin.from("profiles").select("id, salon_id").eq("telegram_id", tg.id).maybeSingle();
  must("profiles.select", found.error);
  if (found.data) {
    if (found.data.salon_id !== salonId) throw new OtherSalon();
    return found.data.id;
  }

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
    // завёл сам вход (telegram_id в app_metadata пишет только service
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
    .upsert({ id, telegram_id: tg.id, salon_id: salonId }, { onConflict: "id", ignoreDuplicates: true });
  // 23505 по telegram_id — параллельный вход успел завести строку
  // раньше; ниже читаем победителя.
  if (ins.error && ins.error.code !== "23505") must("profiles.insert", ins.error);

  const winner = await admin.from("profiles").select("id, salon_id").eq("telegram_id", tg.id).single();
  must("profiles.reselect", winner.error);
  if (winner.data.id !== id && ours) {
    // Проиграли гонку — свой лишний auth-пользователь не оставляем.
    await admin.auth.admin.deleteUser(id);
  }
  if (winner.data.salon_id !== salonId) throw new OtherSalon();
  return winner.data.id;
}

/**
 * Согласие на обработку ПДн (152-ФЗ): есть ли строка на текущую редакцию
 * политики. Без неё аккаунт не заводится и ничего не пишется — клиент
 * показывает экран согласия и повторяет вход с { consent }.
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

export async function handleAuth(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!SERVICE_KEY || !ANON_KEY) {
    console.error("auth: not configured");
    return json(500, { error: "not_configured" });
  }

  let initData = "";
  // Редакция политики, с которой клиент только что согласился на экране
  // согласия. Чужая (устаревший бандл) — не согласие на текущую.
  let consent = "";
  // slug салона из адреса мини-аппа — см. findSalon().
  let slug = "";
  try {
    const body = await req.json();
    if (typeof body?.initData === "string") initData = body.initData;
    if (typeof body?.consent === "string") consent = body.consent;
    if (typeof body?.salon === "string") slug = body.salon;
  } catch {
    // пустое или не-JSON тело — то же, что неверные данные
  }

  let salon;
  try {
    salon = await findSalon(slug);
  } catch (e) {
    console.error("auth:", e instanceof Failure ? e.message : "unexpected error");
    return json(500, { error: "server_error" });
  }
  if (!salon) return json(401, { error: "invalid_init_data" });
  if (salon.tokens.length === 0) {
    console.error("auth: salon without bots");
    return json(500, { error: "not_configured" });
  }

  const { user, expired } = await verify(initData, salon.tokens);
  if (!user) return json(401, { error: expired ? "expired" : "invalid_init_data" });

  try {
    // Чужой салон — до согласия: человек ничего не подписывал этому
    // мастеру, и записывать о нём нечего.
    const existing = await admin.from("profiles").select("salon_id").eq("telegram_id", user.id).maybeSingle();
    must("profiles.select", existing.error);
    if (existing.data && existing.data.salon_id !== salon.id) {
      return json(403, { error: "other_salon" });
    }

    // Согласие — до любой записи о человеке (152-ФЗ, ст. 9): без него ни
    // auth.users, ни profiles не заводятся, а прежний аккаунт не входит,
    // пока не согласится с новой редакцией.
    if (consent === POLICY_VERSION) await recordConsent(user.id);
    else if (!(await hasConsent(user.id))) {
      return json(403, { error: "consent_required", version: POLICY_VERSION });
    }

    const userId = await findOrCreateUser(user, salon.id);
    const session = await mintSession(userId, user);
    // Имя и юзернейм — из проверенного initData; роль не трогаем.
    // Разрешение боту писать (allows_write_to_pm) снимает отметку «бот
    // недоступен» — напоминания пойдут снова. Без него отметку не ставим:
    // поле есть не в каждом initData.
    const upd = await admin
      .from("profiles")
      .update({
        telegram_username: user.username,
        first_name: user.firstName,
        last_name: user.lastName,
        last_login_at: new Date().toISOString(),
        ...(user.allowsWriteToPm ? { bot_unreachable_at: null } : {}),
      })
      .eq("id", userId);
    must("profiles.update", upd.error);
    return json(200, session);
  } catch (e) {
    if (e instanceof OtherSalon) return json(403, { error: "other_salon" });
    console.error("auth:", e instanceof Failure ? e.message : "unexpected error");
    return json(500, { error: "server_error" });
  }
}
