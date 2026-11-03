// POST /api/master-notify — уведомление мастеру о новой заявке клиента.
// { booking_id } с JWT клиента; зовёт BookingScreen.submit() сразу после
// того, как заявка сохранилась (src/bookings.js → notifyMaster).
//
//   1. Строка читается ОТ ИМЕНИ вызывающего: RLS (bookings_select_own)
//      отдаёт только свою — чужой или несуществующий id → 404. JWT
//      проверяет сама база, как в invite.ts;
//   2. пишем только о свежей заявке клиента (status 'new', source
//      'client', создана не раньше FRESH_MS назад) — старый id не
//      повторить, чтобы засыпать мастера сообщениями;
//   3. бот кабинета салона (нет своего — бот клиента) шлёт текст
//      masterNotifyMessage (_shared/master-notify.js) каждому мастеру
//      салона. Имя и юзернейм клиента — из строки, их пишет сервер.
//
// Ничего не хранит: не дошло (мастер не разрешила боту писать — 403,
// сеть) — не повторяется, заявка и так в «Заявках» кабинета. Ответ:
// 200 { sent } | 4xx { error }. В логи — ни токена, ни chat id.

import { createClient } from "npm:@supabase/supabase-js@2";
import { masterNotifyMessage } from "../_shared/master-notify.js";
import {
  ANON_KEY,
  API_URL,
  CORS,
  NO_SESSION,
  SUPABASE_URL,
  admin,
  cabinetBotToken,
  json,
} from "../_shared/server.ts";

const SEND_TIMEOUT_MS = 10_000;
const FRESH_MS = 5 * 60_000;
const COLS =
  "id,salon_id,status,source,created_at,day,start_min,duration,price,service_name,services,comment,client_name,client_username";

// Уже уведомлённые заявки — на экземпляр функции, без базы: повторный
// вызов с тем же id в окне FRESH_MS не пишет мастеру второй раз.
const notified = new Set<number>();

async function send(token: string, chatId: number, body: Record<string, unknown>) {
  try {
    const res = await fetch(`${API_URL}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (!res.ok) console.error(`master-notify: sendMessage: ${res.status}`);
    return res.ok;
  } catch {
    console.error("master-notify: sendMessage: network");
    return false;
  }
}

export async function handleMasterNotify(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer \S+$/.test(authorization)) return json(401, { error: "unauthorized" });

  let id: unknown;
  try {
    id = (await req.json())?.booking_id;
  } catch {
    return json(400, { error: "bad_request" });
  }
  if (!Number.isSafeInteger(id) || (id as number) <= 0) return json(400, { error: "bad_request" });
  const bookingId = id as number;

  // От имени вызывающего — чужую строку RLS просто не отдаст.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    auth: NO_SESSION,
    global: { headers: { authorization } },
  });
  const { data: row, error } = await asCaller.from("bookings").select(COLS).eq("id", bookingId).maybeSingle();
  if (error) {
    // Просроченный или поддельный JWT PostgREST отвергает сам (PGRST3xx);
    // anon к bookings не допущен вовсе (42501).
    if (/^PGRST3|^42501$/.test(error.code ?? "")) return json(401, { error: "unauthorized" });
    console.error("master-notify: bookings.select:", error.code ?? "error");
    return json(500, { error: "server_error" });
  }
  if (!row) return json(404, { error: "not_found" });

  const fresh = Date.now() - new Date(row.created_at).getTime() < FRESH_MS;
  if (row.status !== "new" || row.source !== "client" || !fresh || notified.has(bookingId)) {
    return json(200, { sent: false });
  }
  if (notified.size > 1000) notified.clear();
  notified.add(bookingId);

  const [{ data: salon }, { data: masters, error: mErr }] = await Promise.all([
    admin.from("salons").select("slug").eq("id", row.salon_id).maybeSingle(),
    admin
      .from("profiles")
      .select("telegram_id")
      .eq("salon_id", row.salon_id)
      .eq("role", "master")
      .not("telegram_id", "is", null),
  ]);
  if (mErr) console.error("master-notify: profiles.select:", mErr.code ?? "error");
  const token = salon ? cabinetBotToken(salon.slug) : "";
  if (!token || !masters?.length) return json(200, { sent: false });

  const body = masterNotifyMessage(row);
  const results = await Promise.all(masters.map((m) => send(token, m.telegram_id, body)));
  return json(200, { sent: results.some(Boolean) });
}
