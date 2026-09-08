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
--       то есть перенаправит заявки клиентов себе. С таблицей bookings
--       ставки выше: authenticated-регистрация отдала бы чужому человеку
--       ещё и имена, комментарии и телефоны клиентов.
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

-- ─── Клиенты ───────────────────────────────────────────────────
--  У заявки и раньше были client_name/client_username — но построчно,
--  без устойчивой сущности: телефон и заметка мастера должны пережить
--  отдельную запись, а не обнуляться на следующей. Строки сюда
--  заводит только триггер link_booking_client() ниже (см. его
--  комментарий) — от анонима таблица закрыта полностью.
create table if not exists public.clients (
  id                 bigint generated always as identity primary key,
  name               text    not null default '',
  telegram_username  text    not null default '',
  phone              text    not null default '',
  note               text    not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Пустая строка не участвует в уникальности — иначе все клиенты без
-- юзернейма схлопнулись бы в одну запись.
create unique index if not exists clients_username_uq
  on public.clients (telegram_username)
  where telegram_username <> '';

-- ─── Записи клиентов ───────────────────────────────────────────
--  Раньше заявки не покидали устройство клиента (CloudStorage) и
--  доезжали до мастера только сообщением в чат. Кабинет мастера
--  (admin.html) их не увидит без сервера — поэтому здесь заводим
--  таблицу, сознательно отступая от прежнего правила.
--
--  day/start_min, а не timestamptz/time: PostgREST отдаёт time как
--  "14:00:00", а day+start_min ложится прямо на dateKey()/toMinutes()
--  из src/schedule.js без переразбора.
create table if not exists public.bookings (
  id              bigint generated always as identity primary key,
  day             date    not null,
  start_min       integer not null check (start_min between 0 and 1439),
  -- Длительность и цена денормализованы: правка услуги или её удаление
  -- не должны переписывать то, что уже согласовано с клиентом.
  duration        integer not null check (duration > 0 and duration <= 600),
  price           integer not null check (price between 0 and 9999),
  service_id      text references public.services(id) on delete set null,
  service_name    text    not null,
  -- Из initDataUnsafe.user — непроверенные данные, только для показа мастеру.
  client_name     text    not null default '',
  client_username text    not null default '',
  comment         text    not null default '',
  status          text    not null default 'new' check (status in ('new', 'ok')),
  source          text    not null default 'client' check (source in ('client', 'master')),
  -- Случайный секрет, который клиент придумывает себе сам и хранит рядом
  -- с локальной записью (ключ "k" в src/storage.js). Единственная ниточка
  -- между заявкой на устройстве и строкой здесь: без неё клиент не мог бы
  -- узнать, подтвердила ли мастер запись, — id строки ему не возвращается,
  -- а select по таблице аноним не имеет и иметь не должен.
  -- Не является авторизацией на запись: по нему можно только прочитать
  -- статус, через booking_status() ниже.
  -- Nullable: заявки, заведённые мастером (source = 'master'), и строки
  -- от старых закэшированных бандлов клиента токена не имеют.
  client_token    uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Файл выполняется повторно на уже развёрнутой базе, а create table
-- if not exists новую колонку в существующую таблицу не добавит.
alter table public.bookings add column if not exists client_token uuid;
alter table public.bookings add column if not exists client_id bigint references public.clients(id) on delete set null;

create index if not exists bookings_day_idx on public.bookings (day, start_min);
create index if not exists bookings_client_token_idx on public.bookings (client_token);
create index if not exists bookings_client_id_idx on public.bookings (client_id);

-- ─── Закрытые вручную окошки ─────────────────────────────────────
--  «Закрыть» отдельный слот в панели дня кабинета мастера, не трогая
--  весь день (для этого служит days_off) и не создавая фиктивную запись.
create table if not exists public.blocked_slots (
  day       date    not null,
  start_min integer not null check (start_min between 0 and 1439),
  primary key (day, start_min)
);

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

drop trigger if exists bookings_touch_updated_at on public.bookings;
create trigger bookings_touch_updated_at
  before update on public.bookings
  for each row execute function public.touch_updated_at();

drop trigger if exists clients_touch_updated_at on public.clients;
create trigger clients_touch_updated_at
  before update on public.clients
  for each row execute function public.touch_updated_at();

-- ─── Привязка заявки к клиенту ───────────────────────────────────
--  Аноним не имеет и не должен иметь доступа к clients (там телефон
--  и заметка мастера) — привязка идёт через security definer триггер
--  на INSERT bookings, тем же приёмом, что и booking_status() ниже:
--  RLS обходится в одном контролируемом месте, а не открывается anon
--  напрямую. Сопоставление по telegram_username, если он есть (и имя
--  подтягивается свежее — мастер видит актуальное отображаемое имя);
--  иначе — по точному совпадению имени среди клиентов без юзернейма;
--  не нашли — заводим нового. Пустые client_name/client_username
--  (initDataUnsafe не отдал ничего) оставляют client_id пустым —
--  запись просто не попадёт ни к одному клиенту в «Клиенты».
create or replace function public.link_booking_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  found_id bigint;
begin
  if new.client_username <> '' then
    insert into public.clients (name, telegram_username)
    values (new.client_name, new.client_username)
    on conflict (telegram_username) where telegram_username <> ''
    do update set name = excluded.name
    returning id into found_id;
  elsif new.client_name <> '' then
    select id into found_id from public.clients
      where telegram_username = '' and name = new.client_name
      limit 1;
    if found_id is null then
      insert into public.clients (name) values (new.client_name)
      returning id into found_id;
    end if;
  end if;

  new.client_id = found_id;
  return new;
end
$$;

drop trigger if exists bookings_link_client on public.bookings;
create trigger bookings_link_client
  before insert on public.bookings
  for each row execute function public.link_booking_client();

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
--  bookings — иначе, чем остальные таблицы: анониму нельзя давать
--  select. Anon-ключ публичный, и открытый select отдал бы имена,
--  телефоны и комментарии всех клиентов кому угодно. Читает и правит
--  записи только вошедший мастер (кабинет), анонимный клиент мини-аппа
--  умеет только вставить свою заявку.
-- ═══════════════════════════════════════════════════════════════

alter table public.bookings enable row level security;

drop policy if exists bookings_select_auth  on public.bookings;
drop policy if exists bookings_insert_anon  on public.bookings;
drop policy if exists bookings_insert_auth  on public.bookings;
drop policy if exists bookings_update_auth  on public.bookings;
drop policy if exists bookings_delete_auth  on public.bookings;

create policy bookings_select_auth on public.bookings
  for select to authenticated using (true);

-- Клиент мини-аппа создаёт только свою собственную новую заявку —
-- не может подделать статус "ok" или дату задним числом.
create policy bookings_insert_anon on public.bookings
  for insert to anon
  with check (status = 'new' and source = 'client' and day >= current_date);

create policy bookings_insert_auth on public.bookings
  for insert to authenticated with check (true);

create policy bookings_update_auth on public.bookings
  for update to authenticated using (true) with check (true);

create policy bookings_delete_auth on public.bookings
  for delete to authenticated using (true);

-- ─── booking_status(): статус своей заявки для анонимного клиента ─
--  Мастер подтверждает заявку в кабинете (status → 'ok'), но у клиента
--  запись лежит в CloudStorage его устройства, и без обратного канала
--  экран «Мои записи» вечно показывал бы «Ожидает подтверждения».
--
--  Канал сделан функцией, а НЕ select-политикой для anon: политика
--  открыла бы строку целиком (имя, юзернейм, комментарий, цену), а
--  здесь наружу выходит только статус и только тех строк, чей секретный
--  client_token спрашивающий уже знает. Тот же приём, что у вьюхи
--  busy_slots: security definer обходит RLS bookings в одном
--  контролируемом месте, с фиксированным набором колонок.
--
--  Токен перебрать нельзя (128-битный uuid), а знание токена не даёт
--  ничего, кроме чтения статуса: писать по-прежнему может только мастер.
create or replace function public.booking_status(p_tokens uuid[])
returns table (client_token uuid, status text)
language sql
security definer
stable
set search_path = ''
as $$
  select b.client_token, b.status
  from public.bookings b
  -- Пустой массив и null отсекаются здесь же: = any('{}') не вернёт строк.
  where b.client_token = any (p_tokens)
  -- Потолок на случай подставленного вручную огромного массива.
  limit 100
$$;

-- Функции по умолчанию исполняемы для public — сужаем явно.
revoke all on function public.booking_status(uuid[]) from public;
grant execute on function public.booking_status(uuid[]) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
--  clients — как bookings: телефон и заметка мастера не должны
--  светиться анониму. Строки заводит только link_booking_client()
--  (см. выше) от имени владельца функции — anon-политики нет вовсе,
--  и authenticated не может ни вставить, ни удалить строку напрямую,
--  только читать и править phone/note уже созданных.
-- ═══════════════════════════════════════════════════════════════

alter table public.clients enable row level security;

drop policy if exists clients_select_auth on public.clients;
drop policy if exists clients_update_auth on public.clients;

create policy clients_select_auth on public.clients
  for select to authenticated using (true);

create policy clients_update_auth on public.clients
  for update to authenticated using (true) with check (true);

-- ─── client_stats: клиенты + производные показатели для «Клиенты» ─
--  security_invoker (по умолчанию) — вьюха выполняется от лица
--  вызывающего и потому наследует RLS clients/bookings как есть:
--  authenticated видит всё, anon (без прямого grant) не видит ничего.
--  visit_count::int — та же причина, что у services.price integer, а
--  не numeric: PostgREST отдаёт numeric строкой JSON.
create or replace view public.client_stats as
  select
    c.id,
    c.name,
    c.telegram_username,
    c.phone,
    c.note,
    count(b.id)::int as visit_count,
    max(b.day) as last_visit_at,
    (
      select b2.service_name
      from public.bookings b2
      where b2.client_id = c.id
      group by b2.service_id, b2.service_name
      order by count(*) desc, max(b2.day) desc
      limit 1
    ) as favorite_service_name
  from public.clients c
  left join public.bookings b on b.client_id = c.id
  group by c.id;

grant select on public.client_stats to authenticated;

-- ─── blocked_slots: читают все (это часть доступности), пишет мастер ──

alter table public.blocked_slots enable row level security;

drop policy if exists blocked_slots_select_public on public.blocked_slots;
drop policy if exists blocked_slots_insert_auth   on public.blocked_slots;
drop policy if exists blocked_slots_delete_auth   on public.blocked_slots;

create policy blocked_slots_select_public on public.blocked_slots
  for select to anon, authenticated using (true);

create policy blocked_slots_insert_auth on public.blocked_slots
  for insert to authenticated with check (true);

create policy blocked_slots_delete_auth on public.blocked_slots
  for delete to authenticated using (true);

-- ─── busy_slots: занятость без персональных данных ───────────────
--  Вьюха отдаёт только day/start_min/duration — ни имён, ни цены,
--  ни комментариев. Через неё клиент мини-аппа видит занятость: чужие
--  заявки и закрытые мастером окошки, — не получая доступа к самой
--  таблице bookings. security_invoker = off здесь обязателен: вьюха
--  исполняется от владельца и потому обходит RLS bookings, который
--  анониму select не даёт (и не должен давать).
--
--  ⚠️ У строк из blocked_slots duration = 0 — «окошко» без длительности.
--  Клиент (serverBusyFor в src/schedule.js) подставляет вместо нуля шаг
--  сетки: интервал нулевой длины не перекрыл бы ничего, и закрытый слот
--  остался бы кликабельным.
create or replace view public.busy_slots
  with (security_invoker = off) as
  select day, start_min, duration from public.bookings
  union all
  select day, start_min, 0 as duration from public.blocked_slots;

grant select on public.busy_slots to anon, authenticated;

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

-- ─── Кэш схемы PostgREST ────────────────────────────────────────
--  Новая функция (booking_status) и новая колонка не видны через REST,
--  пока PostgREST не перечитает схему. Supabase обычно делает это сам,
--  но при повторном прогоне файла на живой базе дешевле сказать явно —
--  иначе первый вызов rpc() вернёт «function not found».
notify pgrst, 'reload schema';
