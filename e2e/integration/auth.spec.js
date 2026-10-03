import { expect, test } from "@playwright/test";
import {
  CABINET_BOT,
  ENABLED,
  IT,
  LOCAL_ONLY,
  admin,
  api,
  claims,
  insertBooking,
  login,
  signIn,
  signInitData,
  tgUser,
  workdays,
} from "./support.js";

// Аутентификация: Edge Function telegram-auth на локальном Supabase.
// Подпись проверяет настоящая функция; ответы — настоящие коды HTTP.

test.skip(!ENABLED, "нет SUPABASE_IT_* — локальный Supabase не поднят (см. support.js)");
test.skip(ENABLED && !LOCAL_ONLY, "SUPABASE_IT_URL должен указывать на локальный стек");

const profileOf = async (telegramId) =>
  (await admin(`/rest/v1/profiles?telegram_id=eq.${telegramId}&select=*`)).data;

test.describe("telegram-auth: вход", () => {
  test("верный initData — 200, только поля сессии; JWT привязан к Telegram id", async () => {
    const user = tgUser("Anna");
    const res = await login(signInitData(user));

    expect(res.status).toBe(200);
    expect(Object.keys(res.data).sort()).toEqual([
      "access_token",
      "expires_at",
      "expires_in",
      "refresh_token",
      "token_type",
    ]);
    const jwt = claims(res.data.access_token);
    expect(jwt.role).toBe("authenticated");
    expect(jwt.app_metadata.telegram_id).toBe(user.id);
    // Короткоживущий access-токен (по умолчанию час).
    expect(jwt.exp - jwt.iat).toBeLessThanOrEqual(3600);
  });

  test("первый вход заводит пользователя с ролью user и проверенным именем", async () => {
    const user = tgUser("First");
    expect(await profileOf(user.id)).toEqual([]);

    const s = await signIn(user);
    const [p] = await profileOf(user.id);
    expect(p).toMatchObject({
      id: s.uid,
      telegram_id: user.id,
      role: "user",
      first_name: "First",
      telegram_username: user.username,
    });
    expect(p.last_login_at).not.toBeNull();
  });

  test("повторный вход — тот же пользователь; бот кабинета — тоже он", async () => {
    const user = tgUser("Again");
    const a = await signIn(user);
    const b = await signIn(user);
    const c = await signIn(user, { token: CABINET_BOT });

    expect(b.uid).toBe(a.uid);
    expect(c.uid).toBe(a.uid);
    expect(await profileOf(user.id)).toHaveLength(1);
  });

  test("несколько устройств: свои сессии, выход с одного не трогает другое", async () => {
    const user = tgUser("Multi");
    const phone = await signIn(user);
    const desktop = await signIn(user);
    expect(phone.uid).toBe(desktop.uid);
    expect(phone.refresh).not.toBe(desktop.refresh);
    expect(claims(phone.token).session_id).not.toBe(claims(desktop.token).session_id);

    for (const s of [phone, desktop]) {
      expect((await api("/auth/v1/user", { token: s.token })).status).toBe(200);
    }

    // Выход с телефона (как signOut({ scope: "local" }) в src/supabase.js).
    const out = await api("/auth/v1/logout?scope=local", { method: "POST", token: phone.token });
    expect(out.status).toBe(204);

    const refresh = (token) =>
      api("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: token } });
    expect((await refresh(phone.refresh)).status).toBe(400);
    const kept = await refresh(desktop.refresh);
    expect(kept.status).toBe(200);
    expect(kept.data.user.id).toBe(desktop.uid);
  });

  test("роль, выданная на сервере, переживает повторный вход", async () => {
    const user = tgUser("Boss");
    await signIn(user);
    await admin(`/rest/v1/profiles?telegram_id=eq.${user.id}`, {
      method: "PATCH",
      body: { role: "master" },
    });

    await signIn(user);
    expect((await profileOf(user.id))[0].role).toBe("master");
  });

  test("роль и чужой id в теле запроса игнорируются", async () => {
    const user = tgUser("Sneaky");
    const victim = tgUser("Victim");
    const victimSession = await signIn(victim);

    const res = await login(signInitData(user), {
      role: "master",
      user: { id: victim.id },
      telegram_id: victim.id,
      user_id: victimSession.uid,
    });
    expect(res.status).toBe(200);
    expect(claims(res.data.access_token).sub).not.toBe(victimSession.uid);
    expect(claims(res.data.access_token).app_metadata.telegram_id).toBe(user.id);
    expect((await profileOf(user.id))[0].role).toBe("user");
  });

  test("вход НЕ по юзернейму: тот же username у другого id — другой пользователь", async () => {
    const a = tgUser("Same");
    const b = { ...tgUser("Same"), username: a.username };
    const sa = await signIn(a);
    const sb = await signIn(b);
    expect(sb.uid).not.toBe(sa.uid);
  });
});

test.describe("telegram-auth: отказы — 401", () => {
  test("чужая подпись (другой бот)", async () => {
    const res = await login(signInitData(tgUser("X"), { token: "999:not-our-bot" }));
    expect(res).toEqual({ status: 401, data: { error: "invalid_init_data" } });
  });

  test("подменённый user после подписи", async () => {
    const good = new URLSearchParams(signInitData(tgUser("Real")));
    good.set("user", JSON.stringify(tgUser("Forged")));
    const res = await login(good.toString());
    expect(res).toEqual({ status: 401, data: { error: "invalid_init_data" } });
  });

  test("без hash, пустой, мусор, не JSON", async () => {
    const noHash = new URLSearchParams(signInitData(tgUser("Y")));
    noHash.delete("hash");
    for (const initData of [noHash.toString(), "", "user=%7B%22id%22%3A1%7D", 42]) {
      const res = await login(initData);
      expect(res.status, String(initData)).toBe(401);
    }
    const raw = await fetch(`${IT.url}/functions/v1/telegram-auth`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: IT.anon },
      body: "{not json",
    });
    expect(raw.status).toBe(401);
  });

  test("устаревший initData — 401 expired", async () => {
    const authDate = Math.floor(Date.now() / 1000) - 2 * 3600;
    const res = await login(signInitData(tgUser("Old"), { authDate }));
    expect(res).toEqual({ status: 401, data: { error: "expired" } });
  });

  test("только id пользователя, без initData — 401", async () => {
    const res = await api("/functions/v1/telegram-auth", {
      method: "POST",
      body: { user: { id: 123 }, telegram_id: 123, username: "someone" },
    });
    expect(res.status).toBe(401);
  });

  test("GET — 405", async () => {
    expect((await api("/functions/v1/telegram-auth")).status).toBe(405);
  });
});

test.describe("вход в обход Telegram ничего не даёт", () => {
  test("заранее заведённый аккаунт с адресом tg<id>@… не получает этот Telegram id", async () => {
    const victim = tgUser("Victim");
    // Аккаунт «под жертву» до её первого входа — без telegram_id в app_metadata.
    const squat = await admin("/auth/v1/admin/users", {
      method: "POST",
      body: { email: `tg${victim.id}@telegram.local`, email_confirm: true },
    });
    expect(squat.status).toBe(200);

    const res = await login(signInitData(victim));
    expect(res.status).toBe(500);
    expect(res.data).toEqual({ error: "server_error" });
    expect(await profileOf(victim.id)).toEqual([]);
  });

  test("регистрация по e-mail закрыта", async () => {
    const res = await api("/auth/v1/signup", {
      method: "POST",
      body: { email: `x${Date.now()}@example.com`, password: "Sup3r-secret-pw" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("вход по паролю выключен целиком (провайдер Email без регистрации)", async () => {
    const email = `legacy-pw${Date.now()}@example.com`;
    const password = "Legacy-passw0rd!";
    await admin("/auth/v1/admin/users", { method: "POST", body: { email, password, email_confirm: true } });
    const pw = await api("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
    expect(pw.status).toBe(422);
    expect(pw.data.error_code ?? pw.data.code).toBe("email_provider_disabled");
  });

  test("сессия НЕ из Telegram (даже с ролью master в profiles) — ни заявок, ни прав мастера", async () => {
    // Такой аккаунт может остаться от старой версии или быть заведён руками.
    // Сессию ему выпускаем тем же путём, что и функция (magic link без
    // письма), но без telegram_id в app_metadata — проверяется только SQL.
    const email = `legacy${Date.now()}@example.com`;
    const created = await admin("/auth/v1/admin/users", {
      method: "POST",
      body: { email, email_confirm: true },
    });
    expect(created.status).toBe(200);
    // Роль master в profiles — с ЧУЖИМ (не его JWT) telegram_id.
    const prof = await admin("/rest/v1/profiles", {
      method: "POST",
      body: { id: created.data.id, telegram_id: 1 + Math.floor(Math.random() * 9e6), role: "master" },
    });
    expect(prof.status).toBe(201);
    const link = await admin("/auth/v1/admin/generate_link", {
      method: "POST",
      body: { type: "magiclink", email },
    });
    expect(link.status).toBe(200);
    const verified = await api("/auth/v1/verify", {
      method: "POST",
      body: { type: "magiclink", token_hash: link.data.hashed_token ?? link.data.properties?.hashed_token },
    });
    expect(verified.status).toBe(200);
    const token = verified.data.access_token;
    expect(claims(token).app_metadata.telegram_id).toBeUndefined();

    const ins = await insertBooking(token, { day: workdays()[0] });
    expect(ins.status).toBe(403);
    expect((await api("/rest/v1/bookings?select=id", { token })).data).toEqual([]);
    const approve = await api("/rest/v1/rpc/approve_booking", { method: "POST", token, body: { p_id: 1 } });
    expect(approve.status).toBe(403);
  });
});
