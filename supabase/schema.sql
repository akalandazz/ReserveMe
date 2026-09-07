-- ═══════════════════════════════════════════════════════════════
--  Схема и начальные данные мини-аппа.
--
--  Выполняется целиком в SQL Editor проекта Supabase:
--  https://supabase.com/dashboard/project/jqvtowurygmlhjrzeyba/sql/new
--
--  Файл лежит в репозитории намеренно: раньше весь контент салона был
--  в src/data.js под гитом, теперь он живёт в облаке. Эта схема вместе
--  с сидом — единственный способ воссоздать проект с нуля.
--
--  ⚠️ ПОСЛЕ выполнения обязательны два шага в дашборде:
--    1. Authentication → Users → Add user: e-mail и пароль мастера,
--       обязательно галка «Auto Confirm User» (экрана подтверждения
--       почты в приложении нет).
--    2. Authentication → Sign In / Providers → Email →
--       ВЫКЛЮЧИТЬ «Enable sign ups».
--       Anon-ключ лежит в бандле открыто — границей безопасности служит
--       RLS. При открытой регистрации кто угодно заведёт себе аккаунт,
--       станет authenticated и перепишет прайс, адрес и логин мастера,
--       то есть перенаправит заявки клиентов себе.
-- ═══════════════════════════════════════════════════════════════

-- ─── Настройки: ровно одна строка ──────────────────────────────
create table if not exists public.settings (
  id                 smallint primary key default 1 check (id = 1),
  master_name        text    not null check (length(btrim(master_name)) between 1 and 40),
  -- Пустая строка = логин не задан: кнопки отправки заявок покажут предупреждение.
  master_username    text    not null default '' check (master_username ~ '^[A-Za-z0-9_]{0,32}$'),
  master_phone       text    not null default '',
  slot_step_minutes  integer not null default 30  check (slot_step_minutes in (5, 10, 15, 20, 30, 60)),
  booking_days_ahead integer not null default 14  check (booking_days_ahead between 1 and 60),
  min_lead_minutes   integer not null default 120 check (min_lead_minutes between 0 and 10080),
  working_hours_text text    not null default '',
  address            text    not null default '',
  landmark           text    not null default '',
  transport          text    not null default '',
  map_url            text    not null default '',
  -- {"0": null, "1": {"from":"10:00","to":"19:00"}, … "6": …}
  -- 0 = воскресенье … 6 = суббота. null — выходной.
  -- "to" — время ОКОНЧАНИЯ работы: услуга должна успеть закончиться до него.
  working_hours      jsonb   not null,
  -- [{"id":"morning","label":"Утро (10:00–13:00)"}, …] — для листа ожидания.
  time_of_day        jsonb   not null,
  updated_at         timestamptz not null default now()
);

-- ─── Услуги ────────────────────────────────────────────────────
--  id — text, а не uuid: сохранённые у клиентов заявки ссылаются на
--  услугу по нему (короткий ключ "s"), и по нему же достаётся название
--  давно прошедшей записи. uuid осиротил бы всю историю.
create table if not exists public.services (
  id         text primary key check (id ~ '^[a-z][a-z0-9_]{1,31}$'),
  emoji      text    not null default '💅',
  name       text    not null check (length(btrim(name)) between 1 and 80),
  -- integer, а не numeric: PostgREST отдаёт numeric строкой JSON,
  -- и цена утекла бы в запись клиента как "70".
  price      integer not null check (price between 0 and 9999),
  duration   integer not null check (duration > 0 and duration <= 600 and duration % 15 = 0),
  note       text    not null default '',
  sort       integer not null default 0,
  -- false — услуга скрыта от клиентов, но её название по-прежнему
  -- находится для прошлых записей. Скрывать безопаснее, чем удалять.
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists services_sort_idx on public.services (sort, id);

-- ─── Отдельные выходные и отпуск ───────────────────────────────
create table if not exists public.days_off (
  day  date primary key,
  note text not null default ''
);

-- ─── Блоки «Важной информации» ─────────────────────────────────
--  id — обычный identity: на него, в отличие от services.id, никто не
--  ссылается. Колонка body, а не text: text — имя типа.
create table if not exists public.info_blocks (
  id    bigint generated always as identity primary key,
  emoji text    not null default '',
  title text    not null check (length(btrim(title)) between 1 and 60),
  body  text    not null check (length(btrim(body)) between 1 and 600),
  sort  integer not null default 0
);

create index if not exists info_blocks_sort_idx on public.info_blocks (sort, id);

-- ─── updated_at ────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

drop trigger if exists settings_touch_updated_at on public.settings;
create trigger settings_touch_updated_at
  before update on public.settings
  for each row execute function public.touch_updated_at();

drop trigger if exists services_touch_updated_at on public.services;
create trigger services_touch_updated_at
  before update on public.services
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════
--  RLS: читают все (в том числе незалогиненные клиенты мини-аппа),
--  пишет только вошедший мастер.
--
--  Политика select — using (true), а не using (active): админка ходит
--  через того же клиента, и скрытая услуга обязана оставаться видимой,
--  иначе её название не найдётся для прошлой записи.
-- ═══════════════════════════════════════════════════════════════

alter table public.settings    enable row level security;
alter table public.services    enable row level security;
alter table public.days_off    enable row level security;
alter table public.info_blocks enable row level security;

do $$
declare t text;
begin
  foreach t in array array['settings', 'services', 'days_off', 'info_blocks'] loop
    execute format('drop policy if exists %I_select_public on public.%I', t, t);
    execute format('drop policy if exists %I_insert_auth   on public.%I', t, t);
    execute format('drop policy if exists %I_update_auth   on public.%I', t, t);
    execute format('drop policy if exists %I_delete_auth   on public.%I', t, t);

    execute format(
      'create policy %I_select_public on public.%I for select to anon, authenticated using (true)', t, t);
    execute format(
      'create policy %I_insert_auth on public.%I for insert to authenticated with check (true)', t, t);
    execute format(
      'create policy %I_update_auth on public.%I for update to authenticated using (true) with check (true)', t, t);
    execute format(
      'create policy %I_delete_auth on public.%I for delete to authenticated using (true)', t, t);
  end loop;
end
$$;

-- ═══════════════════════════════════════════════════════════════
--  Сид — значения из прежнего src/data.js дословно, чтобы после
--  миграции приложение выглядело ровно так же, как до неё.
--  on conflict do nothing: файл можно выполнять повторно.
-- ═══════════════════════════════════════════════════════════════

insert into public.settings (
  id, master_name, master_username, master_phone,
  slot_step_minutes, booking_days_ahead, min_lead_minutes,
  working_hours_text, address, landmark, transport, map_url,
  working_hours, time_of_day
) values (
  1,
  'Владислава',
  'vseees',
  '+995 555 12 34 56',
  30, 14, 120,
  'Пн–Ср 10:00–19:00, Чт–Пт 10:00–20:00, Сб 11:00–17:00, Вс — выходной',
  'Тбилиси, ул. Пример, 12, кв. 5',
  'Второй этаж, домофон 5, код 1234. Ориентир — аптека на углу.',
  '10 минут пешком от станции метро Руставели',
  'https://maps.google.com/?q=41.7151,44.8271',
  '{"0": null,
    "1": {"from": "10:00", "to": "19:00"},
    "2": {"from": "10:00", "to": "19:00"},
    "3": {"from": "10:00", "to": "19:00"},
    "4": {"from": "10:00", "to": "20:00"},
    "5": {"from": "10:00", "to": "20:00"},
    "6": {"from": "11:00", "to": "17:00"}}'::jsonb,
  '[{"id": "morning",   "label": "Утро (10:00–13:00)"},
    {"id": "afternoon", "label": "День (13:00–17:00)"},
    {"id": "evening",   "label": "Вечер (17:00–20:00)"},
    {"id": "any",       "label": "Любое время"}]'::jsonb
)
on conflict (id) do nothing;

insert into public.services (id, emoji, name, price, duration, note, sort) values
  ('manicure',     '💅', 'Маникюр комбинированный', 50,  90, 'Снятие, форма, уход за кутикулой', 10),
  ('manicure_gel', '✨', 'Маникюр + гель-лак',      70, 120, 'Покрытие в один тон',              20),
  ('pedicure',     '🦶', 'Педикюр',                 80, 120, '',                                 30),
  ('design',       '🎨', 'Дизайн (за 1 ноготь)',     5,  15, 'Добавляется к основной услуге',    40)
on conflict (id) do nothing;

insert into public.days_off (day) values
  ('2026-01-01'),
  ('2026-01-07')
on conflict (day) do nothing;

insert into public.info_blocks (emoji, title, body, sort)
select * from (values
  ('⏰', 'Опоздания',     'Пожалуйста, предупредите, если опаздываете. При опоздании больше чем на 15 минут запись может быть отменена.', 10),
  ('❌', 'Отмена записи', 'Отменяйте запись не позднее чем за 3 часа — иначе время пропадает.', 20),
  ('💳', 'Оплата',        'Наличными или переводом на карту.', 30),
  ('🧒', 'Дети и гости',  'К сожалению, кабинет маленький — приходите, пожалуйста, одни.', 40),
  ('🩺', 'Здоровье',      'Если есть грибок, порезы или воспаления — напишите мне заранее.', 50)
) as seed(emoji, title, body, sort)
where not exists (select 1 from public.info_blocks);
