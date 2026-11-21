// POST /api/analytics — вкладка «Аналитика» кабинета (AnalyticsSection.jsx →
// fetchAnalytics в src/admin/api.js). { from, to } (ГГГГ-ММ-ДД или null) с
// JWT мастера.
//
// Данные читаются от имени вызывающего (anon-ключ + его JWT): RLS отдаёт
// записи и карточки только мастеру и только его салона, поэтому своих
// проверок салона здесь нет. Роль смотрим в своей строке profiles, чтобы
// ответить 403, а не пустой аналитикой. JWT проверяет база (функция api
// развёрнута без проверки JWT платформой, см. index.ts).
//
// Считает _shared/analytics.js — тот же модуль гоняют e2e/unit. «Сейчас» —
// по часам салона (SALON_TIME_ZONE): записи хранят местные день и минуту.
//
// Ответ: 200 { now, summary, months } | 4xx/5xx { error }.
// В логи — только код ошибки: ни токена, ни сумм, ни id.

import { createClient } from "npm:@supabase/supabase-js@2";
import { analyticsReport, parseRange, wallClock } from "../_shared/analytics.js";
import { ANON_KEY, CORS, NO_SESSION, SUPABASE_URL, json } from "../_shared/server.ts";

// Все салоны сейчас в Тбилиси — как bookings_insert_client в schema.sql.
const SALON_TIME_ZONE = "Asia/Tbilisi";

// PostgREST отдаёт не больше max_rows строк за запрос и молча обрезает
// остальное — читаем страницами до count, как selectAll в store.js.
const PAGE = 1000;

type Row = Record<string, unknown> & { id: unknown };
type PageResult = { data: Row[] | null; error: { code?: string } | null; count: number | null };
type Query = { range: (a: number, b: number) => PromiseLike<PageResult> };

async function selectAll(build: (opts?: { count: "exact" }) => Query) {
  const rows: Row[] = [];
  let total: number | null = null;
  for (;;) {
    const query = total === null ? build({ count: "exact" }) : build();
    const res = await query.range(rows.length, rows.length + PAGE - 1);
    if (res.error) return { data: null, error: res.error };
    const page = res.data ?? [];
    if (total === null) total = res.count ?? Infinity;
    rows.push(...page);
    if (!page.length || rows.length >= total) break;
  }
  // Строка, вставленная между страницами, сдвигает смещение — дубль убираем.
  const seen = new Set();
  const data = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  return { data, error: null };
}

const statusOf = (code = "") => (/^PGRST3/.test(code) ? 401 : code === "42501" ? 403 : 500);

export async function handleAnalytics(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer \S+$/.test(authorization)) return json(401, { error: "Войдите заново" });

  let range;
  try {
    range = parseRange(await req.json());
  } catch {
    return json(400, { error: "bad_request" });
  }
  if (!range) return json(400, { error: "bad_request" });

  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    auth: NO_SESSION,
    global: { headers: { authorization } },
  });

  // Своя строка profiles (profiles_select_own). Нет строки — не вошёл через
  // Telegram; не мастер — 403. Сами данные всё равно закрывает RLS.
  const { data: me, error: meError } = await asCaller.from("profiles").select("role").maybeSingle();
  if (meError) {
    console.error("analytics: profile:", meError.code ?? "error");
    return json(statusOf(meError.code), { error: "Не удалось загрузить аналитику" });
  }
  if (me?.role !== "master") return json(403, { error: "Нет доступа" });

  const [bookings, clients] = await Promise.all([
    selectAll(
      (opts) =>
        asCaller
          .from("bookings")
          .select(
            "id,day,start_min,status,price,client_id,client_name,service_id,service_name,services",
            opts
          )
          .neq("status", "cancelled")
          .order("day", { ascending: true })
          .order("start_min", { ascending: true })
          .order("id", { ascending: true }) as unknown as Query
    ),
    selectAll(
      (opts) =>
        asCaller
          .from("client_stats")
          .select("id,name,telegram_username,phone,channel", opts)
          // Порядок как у «Клиентов» (store.js): равные в «Редко
          // приходят» стоят так же, как стояли бы в кабинете.
          .order("last_visit_at", { ascending: false, nullsFirst: true })
          .order("created_at", { ascending: false })
          .order("id", { ascending: false }) as unknown as Query
    ),
  ]);
  const failed = bookings.error ?? clients.error;
  if (failed) {
    console.error("analytics: select:", failed.code ?? "error");
    return json(statusOf(failed.code), { error: "Не удалось загрузить аналитику" });
  }

  return json(
    200,
    analyticsReport({
      bookings: bookings.data ?? [],
      clients: clients.data ?? [],
      ...range,
      now: wallClock(new Date(), SALON_TIME_ZONE),
    })
  );
}
