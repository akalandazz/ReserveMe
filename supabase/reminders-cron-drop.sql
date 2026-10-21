-- Снять старое расписание напоминаний: pg_cron → Edge Function
-- send-reminders. Теперь напоминания шлёт Vercel Cron
-- (vercel.json → api/send-reminders.js), функции в базе не трогаются.
--
-- Выполняется ОДИН раз в SQL-редакторе проекта, где раньше выполняли
-- supabase/reminders-cron.sql. Повторный запуск безвреден. Расширения
-- pg_cron/pg_net не удаляются — их может использовать что-то ещё.
--
-- Потом из терминала (функция и её секрет больше не нужны):
--   npx supabase functions delete send-reminders
--   npx supabase secrets unset REMINDERS_CRON_SECRET CLIENT_APP_URL

select cron.unschedule(jobid) from cron.job where jobname = 'send-reminders';

delete from vault.secrets where name in ('reminders_function_url', 'reminders_cron_secret');

-- Проверка: пусто.
--   select jobname from cron.job where jobname = 'send-reminders';
