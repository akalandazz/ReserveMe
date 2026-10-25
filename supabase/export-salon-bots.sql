-- ═══════════════════════════════════════════════════════════════
--  Перенос токенов ботов из public.salon_bots в секрет SALON_BOTS —
--  один раз, в SQL Editor, ДО новой schema.sql (она удаляет таблицу,
--  только когда та пуста).
--
--  1. Выполните запрос ниже: он вернёт значение секрета — JSON по slug
--     салона (формат — supabase/functions/_shared/salon-bots.js).
--  2. Салон 1 («main»), если его боты жили не в таблице, а в секретах
--     TELEGRAM_CLIENT_BOT_TOKEN / TELEGRAM_CABINET_BOT_TOKEN /
--     CLIENT_BOT_WEBHOOK_SECRET, — допишите руками:
--       "main": { "client": "…", "cabinet": "…", "webhook_secret": "…" }
--  3. Dashboard → Edge Functions → Secrets → SALON_BOTS = этот JSON (не
--     `supabase secrets set` из репозитория — см. CLAUDE.md). Сохраните
--     его и у себя (masters/salon-bots.json — npm run add-master дописывает
--     туда новые салоны).
--  4. Задеплойте функции api и send-reminders, проверьте вход в мини-апп и
--     кабинет каждого салона и вебхук (бот отвечает на /start).
--  5. truncate public.salon_bots; затем schema.sql — она удалит таблицу.
--     Старые секреты TELEGRAM_*_BOT_TOKEN и CLIENT_BOT_WEBHOOK_SECRET
--     больше не читаются — удалите их в дашборде.
--
--  ⚠️ Результат — токены ботов. Не сохраняйте его в репозиторий.
-- ═══════════════════════════════════════════════════════════════

select jsonb_pretty(coalesce(jsonb_object_agg(s.slug, jsonb_strip_nulls(jsonb_build_object(
         'client',         c.token,
         'cabinet',        nullif(k.token, c.token),
         'webhook_secret', nullif(c.webhook_secret, '')
       )) order by s.slug), '{}'::jsonb)) as salon_bots
  from public.salons s
  join public.salon_bots c on c.salon_id = s.id and c.kind = 'client'
  left join public.salon_bots k on k.salon_id = s.id and k.kind = 'cabinet';
