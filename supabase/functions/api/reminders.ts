// POST /api/reminders — бот клиента напоминает о записи (бывшая функция
// send-reminders).
//
// Без тела, с заголовком x-cron-secret → claim_due_reminders()
// (supabase/schema.sql: подтверждённые записи клиентов мини-аппа, до
// начала которых осталось не больше settings.reminder_hours) → sendMessage
// от бота клиента на profiles.telegram_id → { claimed, sent, unreachable,
// retry, drop }. Что писать и как разбирать ответ Telegram — в
// _shared/reminders.js (его же гоняет e2e/unit).
//
// Зовёт pg_cron раз в 10 минут (supabase/reminders-cron.sql). Запись
// помечается reminded_at ДО отправки, так что наложившиеся запуски не
// напомнят дважды; временная ошибка Telegram возвращает её в очередь.
//
// Салоны: claim_due_reminders() отдаёт записи всех салонов с salon_id, и
// каждый салон пишет СВОИМ ботом клиента (salon_bots, kind = 'client') —
// в том, где клиент открывает мини-апп; другому боту Telegram и не дал бы
// писать. Отправка — по салонам, отдельно: 429 одного бота не задерживает
// напоминания другого. Салон без бота клиента — его записи в очередь.
//
// В логи не пишется ни токен, ни telegram_id, ни текст — только счётчики
// и коды ошибок.

import { deliverReminders } from "../_shared/reminders.js";
import { API_URL, SERVICE_KEY, admin, appUrlFor, clientBotToken, env, json, sameSecret } from "./common.ts";

const CRON_SECRET = env("REMINDERS_CRON_SECRET");

/** Сколько записей за запуск — с запасом до лимита времени функции. */
const BATCH = 50;
const SEND_TIMEOUT_MS = 10_000;
/** Telegram — до ~30 сообщений в секунду на бота. */
const PAUSE_MS = 50;

async function send(token: string, body: unknown): Promise<number> {
  const res = await fetch(`${API_URL}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  await res.body?.cancel();
  await new Promise((r) => setTimeout(r, PAUSE_MS));
  return res.status;
}

async function rpc(name: string, args: Record<string, unknown>) {
  const { error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.code ?? "error"}`);
}

type Salon = { token: string; slug: string };

/** Бот клиента и slug каждого салона из ids; салона без бота в ответе нет. */
async function loadSalons(ids: number[]): Promise<Map<number, Salon>> {
  const out = new Map<number, Salon>();
  const { data, error } = await admin
    .from("salons")
    .select("id, slug, salon_bots(kind, token)")
    .in("id", ids);
  if (error) throw new Error(`salons: ${error.code ?? "error"}`);
  for (const s of data ?? []) {
    const token = clientBotToken(s);
    if (token) out.set(s.id, { token, slug: s.slug });
  }
  return out;
}

export async function handleReminders(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!SERVICE_KEY || !CRON_SECRET) {
    console.error("reminders: not configured");
    return json(500, { error: "not_configured" });
  }
  if (!(await sameSecret(req.headers.get("x-cron-secret") ?? "", CRON_SECRET))) {
    return json(401, { error: "unauthorized" });
  }

  const claimed = await admin.rpc("claim_due_reminders", { p_limit: BATCH });
  if (claimed.error) {
    console.error("reminders: claim:", claimed.error.code ?? "error");
    return json(500, { error: "server_error" });
  }

  const rows = claimed.data ?? [];
  const bySalon = new Map<number, typeof rows>();
  for (const r of rows) bySalon.set(r.salon_id, [...(bySalon.get(r.salon_id) ?? []), r]);

  let salons: Map<number, Salon>;
  try {
    salons = bySalon.size ? await loadSalons([...bySalon.keys()]) : new Map();
  } catch (e) {
    // Без токенов не шлём ничего — всё взятое обратно в очередь.
    console.error("reminders:", e instanceof Error ? e.message : "salons");
    for (const r of rows) await rpc("release_reminder", { p_id: r.booking_id }).catch(() => {});
    return json(500, { error: "server_error" });
  }

  const release = (id: number) => rpc("release_reminder", { p_id: id });
  const counts = { claimed: rows.length, sent: 0, unreachable: 0, retry: 0, drop: 0 };
  for (const [salonId, salonRows] of bySalon) {
    const salon = salons.get(salonId);
    if (!salon) {
      console.error("reminders: salon without client bot");
      for (const r of salonRows) await release(r.booking_id).catch(() => {});
      counts.retry += salonRows.length;
      continue;
    }
    const part = await deliverReminders(salonRows, {
      send: (body: unknown) => send(salon.token, body),
      release,
      markUnreachable: (tgId: number) => rpc("mark_bot_unreachable", { p_telegram_id: tgId }),
      now: new Date(),
      appUrl: appUrlFor(salon.slug),
    });
    for (const k of ["sent", "unreachable", "retry", "drop"] as const) counts[k] += part[k];
  }
  if (counts.claimed) console.log("reminders:", JSON.stringify(counts));
  return json(200, counts);
}
