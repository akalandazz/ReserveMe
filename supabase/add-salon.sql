-- ═══════════════════════════════════════════════════════════════
--  Новый салон (мастер) — выполняется руками в SQL Editor, после
--  supabase/schema.sql. Подставьте значения в input и выполните целиком:
--  салон, его боты и строка настроек появятся в одной транзакции.
--
--  Перед этим в @BotFather у мастера — свой бот клиента (и, если нужен,
--  отдельный бот кабинета; можно один и тот же). Адреса мини-аппов ботов:
--    клиент:  https://<хостинг>/?salon=<slug>
--    кабинет: https://<хостинг>/admin.html?salon=<slug>
--  По slug telegram-auth выбирает, какими токенами проверять initData, —
--  без него вход в этот салон не пройдёт (401).
--
--  Потом:
--    1. Мастер открывает кабинет своим ботом (увидит «Нет доступа») —
--       так появится её аккаунт в ЭТОМ салоне; затем роль:
--         update public.profiles set role = 'master'
--          where telegram_id = <Telegram id мастера> and salon_id = <id салона>;
--    2. Вебхук бота клиента: CLIENT_BOT_SALON=<slug> с токеном и секретом
--       отсюда — node scripts/setup-client-bot.mjs.
--    3. Услуги, адрес и график мастер заводит в кабинете.
--
--  ⚠️ Токены — секреты. Не сохраняйте этот файл с подставленными
--  значениями и не коммитьте их.
-- ═══════════════════════════════════════════════════════════════

begin;

with input as (
  select
    'salon-slug'::text               as slug,           -- a–z 0–9 -, 2–32 символа
    'Имя мастера'::text              as master_name,
    '123456:CLIENT-BOT-TOKEN'::text  as client_token,
    '123456:CABINET-BOT-TOKEN'::text as cabinet_token,  -- или тот же, что client_token
    'webhook-secret'::text           as webhook_secret  -- A–Z a–z 0–9 _ -, 1–256
), salon as (
  insert into public.salons (id, slug)
  select coalesce((select max(id) from public.salons), 0) + 1, slug from input
  returning id
), bots as (
  -- Выполняется, хотя ниже на него никто не ссылается: изменяющие CTE
  -- Postgres исполняет всегда.
  insert into public.salon_bots (salon_id, kind, token, webhook_secret)
  select salon.id, 'client', input.client_token, input.webhook_secret from salon, input
  union all
  select salon.id, 'cabinet', input.cabinet_token, '' from salon, input
)
insert into public.settings (salon_id, master_name, working_hours, time_of_day)
select salon.id, input.master_name,
  '{"0": null,
    "1": {"from": "10:00", "to": "19:00"},
    "2": {"from": "10:00", "to": "19:00"},
    "3": {"from": "10:00", "to": "19:00"},
    "4": {"from": "10:00", "to": "19:00"},
    "5": {"from": "10:00", "to": "19:00"},
    "6": null}'::jsonb,
  '[{"id": "morning",   "label": "Утро (10:00–13:00)"},
    {"id": "afternoon", "label": "День (13:00–17:00)"},
    {"id": "evening",   "label": "Вечер (17:00–20:00)"},
    {"id": "any",       "label": "Любое время"}]'::jsonb
from salon, input;

select id, slug from public.salons order by id;

commit;
