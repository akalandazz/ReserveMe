-- Расписание напоминаний о записи: pg_cron раз в 10 минут зовёт Edge
-- Function send-reminders (supabase/functions/send-reminders).
--
-- Выполняется ОДИН раз в SQL-редакторе проекта, после schema.sql и
-- деплоя функции. В schema.sql не входит намеренно: локальный стек
-- интеграционных тестов поднимается из schema.sql, и cron там слал бы
-- запросы сам по себе, мешая тестам.
--
-- Адрес функции и секрет — в Vault, не в тексте задачи: cron.job читают
-- не только суперпользователи. Секрет тот же, что
-- REMINDERS_CRON_SECRET у функции. Секреты функции задавать в дашборде
-- (Edge Functions → Secrets), не `supabase secrets set` из репозитория:
-- CLI заодно заливает тестовые значения из [edge_runtime.secrets] в
-- supabase/config.toml поверх настоящих токенов ботов.
--
-- Перед первым запуском (подставьте свои значения, один раз):
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/send-reminders',
--                              'reminders_function_url');
--   select vault.create_secret('<тот же REMINDERS_CRON_SECRET>', 'reminders_cron_secret');
-- Поменять потом: vault.update_secret(id, new_secret) — id из
--   select id, name from vault.secrets;
--
-- Выключить напоминания: в кабинете «Напоминание» → «Выкл.» (settings.
-- reminder_hours = 0) или совсем убрать задачу:
--   select cron.unschedule('send-reminders');

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- cron.schedule с тем же именем заменяет задачу — файл можно выполнить повторно.
select cron.schedule(
  'send-reminders',
  '*/10 * * * *',
  $job$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets
                   where name = 'reminders_function_url'),
      headers := jsonb_build_object(
                   'content-type', 'application/json',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'reminders_cron_secret')),
      body    := '{}'::jsonb,
      timeout_milliseconds := 60000
    )
    where exists (select 1 from vault.decrypted_secrets where name = 'reminders_function_url')
  $job$
);

-- Проверка: последние запуски и ответы функции.
--   select * from cron.job_run_details where jobid =
--     (select jobid from cron.job where jobname = 'send-reminders')
--   order by start_time desc limit 10;
--   select status_code, content from net._http_response order by created desc limit 10;
