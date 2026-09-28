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
--  заводят триггер link_booking_client() ниже (заявки клиентов) и
--  мастер из кабинета («Новый клиент», «Новая запись») — от анонима
--  таблица закрыта полностью.
create table if not exists public.clients (
  id                 bigint generated always as identity primary key,
  name               text    not null default '',
  telegram_username  text    not null default '',
  phone              text    not null default '',
  -- Устарело: заметка переехала в client_comments (миграция ниже
  -- переносит её первым комментарием и обнуляет). Колонка оставлена,
  -- чтобы закэшированный старый бандл кабинета не падал на update.
  note               text    not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ─── Комментарии мастера к клиенту ───────────────────────────────
--  Вместо одного поля note — лента: мастер дописывает, а не
--  переписывает, и у каждой записи есть дата.
create table if not exists public.client_comments (
  id         bigint generated always as identity primary key,
  client_id  bigint not null references public.clients(id) on delete cascade,
  body       text   not null check (length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists client_comments_client_idx
  on public.client_comments (client_id, created_at desc);

-- Перенос старой заметки первым комментарием. Идемпотентно: после
-- переноса note обнуляется, повторный прогон файла ничего не найдёт.
insert into public.client_comments (client_id, body, created_at)
  select id, left(btrim(note), 1000), updated_at
  from public.clients
  where btrim(note) <> '';
update public.clients set note = '' where note <> '';

-- Пустая строка не участвует в уникальности — иначе все клиенты без
-- юзернейма схлопнулись бы в одну запись.
create unique index if not exists clients_username_uq
  on public.clients (telegram_username)
  where telegram_username <> '';

-- Откуда клиент пишет мастеру — для тех, кого она заводит сама
-- («Новая запись» → «Новый клиент»): WhatsApp, Instagram, звонок,
-- лично, Telegram. Пустая строка — не указано (клиенты из заявок
-- мини-аппа: у них и так есть telegram_username).
alter table public.clients add column if not exists channel text not null default '';
do $$
begin
  alter table public.clients add constraint clients_channel_chk
    check (channel in ('', 'wa', 'ig', 'call', 'live', 'tg'));
exception when duplicate_object then null;
end
$$;

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
--  напрямую. Сопоставление по telegram_username, если он есть;
--  иначе — по точному совпадению имени среди клиентов без юзернейма;
--  не нашли — заводим нового. Пустые client_name/client_username
--  (initDataUnsafe не отдал ничего) оставляют client_id пустым —
--  запись просто не попадёт ни к одному клиенту в «Клиенты».
--
--  Имя уже известного клиента НЕ перезаписывается телеграмным: мастер
--  переименовывает клиентов в кабинете, и следующая заявка не должна
--  откатывать её правку. Телеграмное имя берётся, только если своего
--  ещё нет.
--
--  Запись, которую заводит сам мастер (create_master_booking ниже),
--  приходит уже с client_id — её не перепривязываем: совпадение по
--  имени могло бы увести её к однофамильцу. Аноним source = 'master'
--  подставить не может (см. политику bookings_insert_anon).
create or replace function public.link_booking_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  found_id bigint;
begin
  if new.source = 'master' and new.client_id is not null then
    return new;
  end if;

  if new.client_username <> '' then
    insert into public.clients (name, telegram_username)
    values (new.client_name, new.client_username)
    on conflict (telegram_username) where telegram_username <> ''
    do update set name = case
      when public.clients.name = '' then excluded.name
      else public.clients.name
    end
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
--  clients — как bookings: телефон и комментарии мастера не должны
--  светиться анониму. anon-политик нет вовсе. Мастер читает, правит
--  и заводит клиентов («Новый клиент» в кабинете); удалять строку
--  напрямую не может никто — у клиента есть история записей.
-- ═══════════════════════════════════════════════════════════════

alter table public.clients enable row level security;

drop policy if exists clients_select_auth on public.clients;
drop policy if exists clients_insert_auth on public.clients;
drop policy if exists clients_update_auth on public.clients;

create policy clients_select_auth on public.clients
  for select to authenticated using (true);

create policy clients_insert_auth on public.clients
  for insert to authenticated with check (true);

create policy clients_update_auth on public.clients
  for update to authenticated using (true) with check (true);

-- ─── client_comments: только мастер ─────────────────────────────

alter table public.client_comments enable row level security;

drop policy if exists client_comments_select_auth on public.client_comments;
drop policy if exists client_comments_insert_auth on public.client_comments;
drop policy if exists client_comments_delete_auth on public.client_comments;

create policy client_comments_select_auth on public.client_comments
  for select to authenticated using (true);

create policy client_comments_insert_auth on public.client_comments
  for insert to authenticated with check (true);

create policy client_comments_delete_auth on public.client_comments
  for delete to authenticated using (true);

-- ─── client_stats: клиенты + производные показатели для «Клиенты» ─
--  security_invoker = on — задан ЯВНО: по умолчанию вьюха в Postgres
--  исполняется от владельца и обходит RLS, а Supabase по default
--  privileges выдаёт anon select на каждую новую вьюху в public —
--  вместе это отдало бы телефоны всех клиентов по публичному ключу.
--  С invoker вьюха наследует RLS clients/bookings: authenticated видит
--  всё, anon — ничего.
--
--  visit_count / last_visit_at — только ПРОШЕДШИЕ записи (визит, а не
--  заявка), по местному времени салона: day/start_min хранятся как
--  тбилисские дата и минуты, а now() — в UTC.
--  favorite_service_id — самая частая услуга среди всех записей
--  клиента; название берётся текущее, из services.
--  ::int — та же причина, что у services.price integer, а не numeric:
--  PostgREST отдаёт numeric/bigint-агрегаты строкой JSON.
--
--  drop, а не create or replace: replace не умеет убирать колонку
--  (note) и менять состав колонок.
drop view if exists public.client_stats;
create view public.client_stats
  with (security_invoker = on) as
  select
    c.id,
    c.name,
    c.telegram_username,
    c.phone,
    c.channel,
    c.created_at,
    v.visit_count,
    v.last_visit_at,
    fav.service_id as favorite_service_id,
    s.name as favorite_service_name
  from public.clients c
  left join lateral (
    select count(*)::int as visit_count, max(b.day) as last_visit_at
    from public.bookings b
    where b.client_id = c.id
      and b.day + make_interval(mins => b.start_min)
          < (now() at time zone 'Asia/Tbilisi')
  ) v on true
  left join lateral (
    select b2.service_id
    from public.bookings b2
    where b2.client_id = c.id and b2.service_id is not null
    group by b2.service_id
    order by count(*) desc, max(b2.day) desc
    limit 1
  ) fav on true
  left join public.services s on s.id = fav.service_id;

revoke all on public.client_stats from anon;
grant select on public.client_stats to authenticated;

-- ─── free_slots(): свободные старты под услугу, для «Новой записи» ─
--  Считается на сервере, а не в кабинете: там же, где проверяет
--  create_master_booking(), — одно правило на показ и на запись.
--  Старт подходит, если вся услуга [t, t + duration):
--    • укладывается в рабочие часы дня недели, и день не в days_off;
--    • не пересекает ни одну запись и ни одно закрытое окошко
--      (у закрытого окошка длина — шаг сетки, как в busy_slots);
--    • не в прошлом (сегодня — строго позже текущего времени);
--    • стоит на сетке settings.slot_step_minutes от начала рабочего
--      дня — той же, что строки панели «День», иначе «Записать» в
--      свободной строке предлагал бы время, которого нет в списке.
--  security invoker: читает bookings под RLS вызывающего, поэтому
--  исполнять её может только authenticated (см. revoke ниже).
--
--  p_exclude_id — запись, которую переносят: её собственное время не
--  должно считаться занятым (иначе сдвинуть запись на полчаса нельзя).
--  drop перед create: у функции сменился список аргументов, а create
--  or replace завёл бы вторую перегрузку рядом со старой.
drop function if exists public.free_slots(date, text);
create or replace function public.free_slots(
  p_day        date,
  p_service_id text,
  p_exclude_id bigint default null
)
returns table (start_min integer)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  local_now timestamp := now() at time zone 'Asia/Tbilisi';
  wh        jsonb;
  hours     jsonb;
  dur       integer;
  step      integer;
  open_min  integer;
  close_min integer;
  now_min   integer;
begin
  select st.working_hours, st.slot_step_minutes into wh, step
    from public.settings st where st.id = 1;
  select sv.duration into dur from public.services sv where sv.id = p_service_id;
  if wh is null or dur is null or p_day < local_now::date then
    return;
  end if;
  if exists (select 1 from public.days_off d where d.day = p_day) then
    return;
  end if;

  hours := wh -> extract(dow from p_day)::int::text;
  if hours is null or jsonb_typeof(hours) <> 'object' then
    return;
  end if;

  open_min  := extract(epoch from (hours ->> 'from')::time)::int / 60;
  close_min := extract(epoch from (hours ->> 'to')::time)::int / 60;
  now_min   := case when p_day = local_now::date
                 then extract(epoch from local_now::time)::int / 60
                 else -1 end;

  return query
    select g.m
    from generate_series(open_min, close_min - dur, step) as g(m)
    where g.m > now_min
      and not exists (
        select 1 from public.bookings b
        where b.day = p_day
          and b.id is distinct from p_exclude_id
          and b.start_min < g.m + dur
          and g.m < b.start_min + b.duration
      )
      and not exists (
        select 1 from public.blocked_slots x
        where x.day = p_day
          and x.start_min < g.m + dur
          and g.m < x.start_min + step
      )
    order by g.m;
end
$$;

revoke all on function public.free_slots(date, text, bigint) from public, anon;
grant execute on function public.free_slots(date, text, bigint) to authenticated;

-- ─── free_slot_counts(): сколько свободных стартов в каждом дне ────
--  Для шага «Выберите день» листа записи: список из трёх недель с
--  «свободно окошек: N» — одним запросом, а не двадцатью одним. Считает
--  та же free_slots(), так что число всегда совпадает со списком времени
--  на следующем шаге. p_days ограничен, чтобы случайный огромный
--  диапазон не превратился в тяжёлый запрос.
create or replace function public.free_slot_counts(
  p_from       date,
  p_days       integer,
  p_service_id text,
  p_exclude_id bigint default null
)
returns table (day date, free_count integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select d::date,
         (select count(*)::int
            from public.free_slots(d::date, p_service_id, p_exclude_id))
  from generate_series(
    p_from,
    p_from + (least(greatest(p_days, 1), 62) - 1),
    interval '1 day'
  ) as d
  order by 1
$$;

revoke all on function public.free_slot_counts(date, integer, text, bigint) from public, anon;
grant execute on function public.free_slot_counts(date, integer, text, bigint) to authenticated;

-- ─── create_master_booking(): мастер записывает клиента сама ──────
--  Одна транзакция на «клиент + запись»: новый клиент из «Новый
--  клиент» не должен остаться сиротой, если слот успели занять.
--  Запись сразу подтверждённая (status 'ok', source 'master') — в
--  «Заявки» она не попадает. Время перепроверяется по free_slots()
--  под advisory-локом дня: две вкладки кабинета не запишут двоих на
--  одно окно. (Заявка клиента лок не берёт — её мастер и так
--  разбирает руками.)
--  Старая шестиаргументная версия удаляется: иначе она осталась бы
--  перегрузкой без телеграма, канала и комментария.
drop function if exists public.create_master_booking(bigint, text, text, text, date, integer);
create or replace function public.create_master_booking(
  p_client_id    bigint,
  p_new_name     text,
  p_new_phone    text,
  p_new_telegram text,
  p_new_channel  text,
  p_service_id   text,
  p_day          date,
  p_start_min    integer,
  p_comment      text
)
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  svc    public.services;
  cl     public.clients;
  new_id bigint;
begin
  select * into svc from public.services sv where sv.id = p_service_id;
  if not found then
    raise exception 'Услуга не найдена — обновите страницу';
  end if;

  perform pg_advisory_xact_lock(hashtext('bookings:' || p_day::text));
  if not exists (
    select 1 from public.free_slots(p_day, p_service_id) f
    where f.start_min = p_start_min
  ) then
    raise exception 'Это время уже занято — выберите другое';
  end if;

  if p_client_id is not null then
    select * into cl from public.clients c where c.id = p_client_id;
    if not found then
      raise exception 'Клиент не найден — обновите страницу';
    end if;
  else
    if coalesce(btrim(p_new_name), '') = '' then
      raise exception 'Укажите имя клиента.';
    end if;
    insert into public.clients (name, phone, telegram_username, channel)
      values (
        btrim(p_new_name),
        coalesce(btrim(p_new_phone), ''),
        regexp_replace(coalesce(btrim(p_new_telegram), ''), '^@+', ''),
        coalesce(p_new_channel, '')
      )
      returning * into cl;
  end if;

  insert into public.bookings (
    day, start_min, duration, price, service_id, service_name,
    client_name, client_username, comment, status, source, client_id
  ) values (
    p_day, p_start_min, svc.duration, svc.price, svc.id, svc.name,
    cl.name, cl.telegram_username, left(coalesce(btrim(p_comment), ''), 1000),
    'ok', 'master', cl.id
  )
  returning id into new_id;

  return new_id;
end
$$;

revoke all on function public.create_master_booking(bigint, text, text, text, text, text, date, integer, text)
  from public, anon;
grant execute on function public.create_master_booking(bigint, text, text, text, text, text, date, integer, text)
  to authenticated;

-- ─── update_master_booking(): правка записи из листа «Изменить» ───
--  Одним вызовом: данные клиента (имя/телефон/телеграм), смена клиента
--  на другого или нового, услуга, перенос, комментарий — и запись
--  становится подтверждённой (сохранение заявки = её подтверждение).
--  Одна транзакция по той же причине, что у create_master_booking:
--  новый клиент не должен остаться сиротой, если новое время заняли.
--
--  Время перепроверяется, только если поменялись день, старт или
--  услуга, — и без самой этой записи (p_exclude_id в free_slots):
--  иначе нельзя было бы сдвинуть запись на полчаса в пределах её же
--  окна. Если услуга та же, цена и длительность остаются прежними —
--  это то, что уже согласовано с клиентом (см. денормализацию выше).
--  p_client_channel = null — канал клиента не трогаем (форма правки
--  его не показывает).
create or replace function public.update_master_booking(
  p_id              bigint,
  p_client_id       bigint,
  p_client_name     text,
  p_client_phone    text,
  p_client_telegram text,
  p_client_channel  text,
  p_service_id      text,
  p_day             date,
  p_start_min       integer,
  p_comment         text
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  bk    public.bookings;
  svc   public.services;
  cl    public.clients;
  nm    text := coalesce(btrim(p_client_name), '');
  tgu   text := regexp_replace(coalesce(btrim(p_client_telegram), ''), '^@+', '');
  moved boolean;
begin
  if nm = '' then
    raise exception 'Укажите имя клиента.';
  end if;

  select * into svc from public.services sv where sv.id = p_service_id;
  if not found then
    raise exception 'Услуга не найдена — обновите страницу';
  end if;

  perform pg_advisory_xact_lock(hashtext('bookings:' || p_day::text));
  select * into bk from public.bookings b where b.id = p_id for update;
  if not found then
    raise exception 'Запись не найдена — обновите страницу';
  end if;

  moved := bk.day <> p_day
        or bk.start_min <> p_start_min
        or bk.service_id is distinct from p_service_id;
  if moved and not exists (
    select 1 from public.free_slots(p_day, p_service_id, p_id) f
    where f.start_min = p_start_min
  ) then
    raise exception 'Это время уже занято — выберите другое';
  end if;

  if p_client_id is null then
    insert into public.clients (name, phone, telegram_username, channel)
      values (nm, coalesce(btrim(p_client_phone), ''), tgu, coalesce(p_client_channel, ''))
      returning * into cl;
  else
    update public.clients c
       set name = nm,
           phone = coalesce(btrim(p_client_phone), ''),
           telegram_username = tgu,
           channel = coalesce(p_client_channel, c.channel)
     where c.id = p_client_id
     returning * into cl;
    if not found then
      raise exception 'Клиент не найден — обновите страницу';
    end if;
  end if;

  update public.bookings b set
    day             = p_day,
    start_min       = p_start_min,
    service_id      = svc.id,
    service_name    = case when bk.service_id is distinct from svc.id then svc.name     else b.service_name end,
    duration        = case when bk.service_id is distinct from svc.id then svc.duration else b.duration     end,
    price           = case when bk.service_id is distinct from svc.id then svc.price    else b.price        end,
    client_id       = cl.id,
    client_name     = cl.name,
    client_username = cl.telegram_username,
    comment         = left(coalesce(btrim(p_comment), ''), 1000),
    status          = 'ok'
  where b.id = p_id;
end
$$;

revoke all on function public.update_master_booking(bigint, bigint, text, text, text, text, text, date, integer, text)
  from public, anon;
grant execute on function public.update_master_booking(bigint, bigint, text, text, text, text, text, date, integer, text)
  to authenticated;

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
