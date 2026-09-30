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

-- ─── Роли аккаунтов ──────────────────────────────────────────────
--  Клиенты мини-аппа теперь регистрируются сами (e-mail + пароль), и
--  «вошёл» больше не значит «мастер». Роль лежит здесь: 'user' — любой
--  клиент, 'master' — только мастер (выдаётся руками, см. is_master()).
--
--  Триггера на auth.users нет — строку создаёт само приложение
--  (ensureProfile() в src/supabase.js) после регистрации или входа.
--  Отсутствующая строка равна 'user': is_master() требует явного
--  'master', так что незаписанная роль никому ничего не открывает.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'user' check (role in ('user', 'master')),
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

-- Аккаунт мини-аппа, если клиент записывался сам: link_booking_client()
-- находит клиента по нему раньше, чем по юзернейму и имени, — аккаунт
-- устойчивее и того, и другого. email — из того же аккаунта, чтобы
-- мастер знала, кто это, даже когда Telegram не отдал ни имени, ни логина.
alter table public.clients add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.clients add column if not exists email text not null default '';
create unique index if not exists clients_user_id_uq
  on public.clients (user_id)
  where user_id is not null;
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
  -- 'cancelled' — отменена клиентом или мастером (кто — в cancelled_by).
  -- Строка остаётся, а не удаляется: клиент видит в «Мои записи», что
  -- мастер отменила запись, а не что она пропала. Проверка значений —
  -- ниже, отдельным alter table.
  status          text    not null default 'new',
  source          text    not null default 'client' check (source in ('client', 'master')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Файл выполняется повторно на уже развёрнутой базе, а create table
-- if not exists новую колонку в существующую таблицу не добавит.
alter table public.bookings add column if not exists client_id bigint references public.clients(id) on delete set null;
-- Аккаунт клиента мини-аппа, который оставил заявку. Единственный
-- источник правды для «Мои записи»: клиент читает свои строки по нему
-- (bookings_select_own), а ставит его только сервер — guard_client_booking()
-- пишет сюда auth.uid(), что бы ни прислал клиент. Пусто у записей,
-- которые завела мастер (source = 'master').
alter table public.bookings add column if not exists user_id uuid references auth.users(id) on delete set null;
-- Устарело: client_token связывал заявку с копией на устройстве клиента
-- (CloudStorage) до того, как мини-апп стал требовать вход. Новый бандл его
-- не шлёт и не читает; колонка и индекс остаются, пока старые закэшированные
-- бандлы шлют её во вставке, — потом их можно удалить:
--   drop index if exists public.bookings_client_token_uq;
--   alter table public.bookings drop column if exists client_token;
alter table public.bookings add column if not exists client_token uuid;
-- Кто отменил: 'client' (cancel_own_booking) или 'master' (кабинет).
-- cancel_seen — мастер видела отмену клиента в «Заявках» («Понятно»).
alter table public.bookings add column if not exists cancelled_by text not null default '';
alter table public.bookings add column if not exists cancel_seen boolean not null default false;

-- Проверка статуса вынесена из create table: там её не расширить на
-- живой базе. Имя — то, что Postgres дал прежней inline-проверке.
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('new', 'ok', 'cancelled'));
alter table public.bookings drop constraint if exists bookings_cancelled_by_check;
alter table public.bookings add constraint bookings_cancelled_by_check
  check (cancelled_by in ('', 'client', 'master'));

create index if not exists bookings_day_idx on public.bookings (day, start_min);
create index if not exists bookings_client_id_idx on public.bookings (client_id);
-- «Мои записи»: select по user_id = auth.uid().
create index if not exists bookings_user_id_idx on public.bookings (user_id, day);
-- Для on delete set null при удалении услуги — иначе полный проход по bookings.
create index if not exists bookings_service_id_idx on public.bookings (service_id);
-- Устарело вместе с client_token (см. выше). Пока старые бандлы досылают
-- заявки повторно, уникальный индекс не даёт им задвоиться.
drop index if exists public.bookings_client_token_idx;
create unique index if not exists bookings_client_token_uq
  on public.bookings (client_token)
  where client_token is not null;

-- Потолки длины текстов: вставлять в bookings может аноним, и без них
-- одна строка могла бы нести мегабайты. not valid — старые строки не
-- перепроверяются (повторный прогон на живой базе не упадёт), новые и
-- изменённые — проверяются.
do $$
begin
  alter table public.bookings add constraint bookings_text_len_chk
    check (length(comment) <= 1000
       and length(client_name) <= 128
       and length(client_username) <= 64
       and length(service_name) <= 80) not valid;
exception when duplicate_object then null;
end
$$;

-- Две ПОДТВЕРЖДЁННЫЕ записи не могут пересекаться по времени — это
-- гарантия самой базы, поверх проверок в функциях ниже. Заявки ('new')
-- пересекаться могут: их мастер разбирает руками.
-- Если в базе уже лежат пересекающиеся подтверждённые записи, ограничение
-- не создастся (notice в выводе) — разведите их в кабинете и прогоните
-- файл ещё раз.
create extension if not exists btree_gist with schema extensions;
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'bookings_no_overlap_ok') then
    return;
  end if;
  alter table public.bookings add constraint bookings_no_overlap_ok
    exclude using gist (
      day with =,
      int4range(start_min, start_min + duration) with &&
    ) where (status = 'ok');
exception
  when exclusion_violation then
    raise notice 'bookings_no_overlap_ok не создано: есть пересекающиеся подтверждённые записи';
end
$$;

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

-- ─── Заявка клиента: сервер решает, что в ней лежит ─────────────
--  Anon-политика проверяет только status/source/day, а остальные
--  колонки аноним присылает какие хочет: длительность 600 минут на
--  каждый день вперёд закрыла бы клиентам всё расписание через
--  busy_slots. Поэтому у заявок клиента (source = 'client') длительность,
--  цена и название услуги всегда берутся из services, день ограничен
--  окном записи, тексты обрезаются, служебные поля выставляются здесь.
--  Старые бандлы клиента продолжают работать: они шлют те же колонки,
--  просто их значения теперь перезаписываются.
--
--  Время тоже проверяется: рабочий день недели, не в days_off, услуга
--  укладывается в часы, старт стоит на сетке. Сетка — та же, что у
--  buildSlots() в src/schedule.js: от начала рабочего дня, а для
--  «сегодня» — от полуночи (там earliest округляется до шага), поэтому
--  подходит любая из двух. Пересечения с чужими заявками НЕ проверяются:
--  две заявки на одно окно — обычное дело, их разбирает мастер.
--
--  Потолок max_per_hour на все заявки клиентов салона за скользящий
--  час: anon-ключ публичный, и без него скрипт закрыл бы клиентам всё
--  расписание через busy_slots за минуту. Потолок не отличает людей —
--  личность клиента (initDataUnsafe) не проверена, и пока её не
--  проверяет сервер, другого ключа для лимита нет. Поднимите число, если
--  настоящих заявок в час бывает больше.
--
--  Отказ триггера клиент видит: createBooking (src/bookings.js) ждёт
--  ответа, и без строки в базе сообщение мастеру не уходит.
--
--  user_id — всегда auth.uid(), а не то, что прислал клиент: по нему
--  клиент потом читает «Мои записи» (bookings_select_own).
--
--  security definer — не для services/settings (их anon читает и так), а
--  для подсчёта потолка: select по bookings анониму закрыт RLS, и под
--  invoker он всегда видел бы ноль заявок.
--
--  Имя триггера — до bookings_link_client по алфавиту: Postgres вызывает
--  before-триггеры в порядке имён, и привязка видит уже очищенную строку.
create index if not exists bookings_client_created_idx
  on public.bookings (created_at)
  where source = 'client';

create or replace function public.guard_client_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  max_per_hour constant integer := 30;
  svc       public.services;
  st        public.settings;
  hours     jsonb;
  open_min  integer;
  close_min integer;
  today     date := (now() at time zone 'Asia/Tbilisi')::date;
begin
  if new.source <> 'client' then
    return new;
  end if;

  select * into svc from public.services s where s.id = new.service_id;
  if not found then
    raise exception 'Услуга не найдена';
  end if;

  select * into st from public.settings s where s.id = 1;
  if not found then
    raise exception 'Салон не настроен';
  end if;

  -- today - 1: список дней клиент строит по часам устройства, а у
  -- клиента западнее Тбилиси «сегодня» ещё вчерашнее по Тбилиси.
  if new.day < today - 1 or new.day > today + st.booking_days_ahead then
    raise exception 'День вне окна записи';
  end if;

  if exists (select 1 from public.days_off d where d.day = new.day) then
    raise exception 'В этот день мастер не принимает';
  end if;

  hours := st.working_hours -> extract(dow from new.day)::int::text;
  if hours is null or jsonb_typeof(hours) <> 'object' then
    raise exception 'В этот день мастер не принимает';
  end if;
  open_min  := extract(epoch from (hours ->> 'from')::time)::int / 60;
  close_min := extract(epoch from (hours ->> 'to')::time)::int / 60;
  if new.start_min < open_min
     or new.start_min + svc.duration > close_min
     or ((new.start_min - open_min) % st.slot_step_minutes <> 0
         and new.start_min % st.slot_step_minutes <> 0) then
    raise exception 'Такого времени нет в расписании';
  end if;

  -- Лок — чтобы параллельные вставки не прошли потолок все разом,
  -- посчитав одно и то же число.
  perform pg_advisory_xact_lock(hashtext('bookings:client-rate'));
  if (select count(*) from public.bookings b
       where b.source = 'client'
         and b.created_at > now() - interval '1 hour') >= max_per_hour then
    raise exception 'Слишком много заявок — попробуйте позже';
  end if;

  new.duration        := svc.duration;
  new.price           := svc.price;
  new.service_name    := svc.name;
  new.status          := 'new';
  new.user_id         := auth.uid();
  new.cancelled_by    := '';
  new.cancel_seen     := false;
  new.client_id       := null; -- выставит link_booking_client()
  new.client_name     := left(btrim(coalesce(new.client_name, '')), 128);
  new.client_username := left(btrim(coalesce(new.client_username, '')), 64);
  new.comment         := left(btrim(coalesce(new.comment, '')), 1000);
  new.created_at      := now();
  new.updated_at      := now();
  return new;
end
$$;

drop trigger if exists bookings_guard_client on public.bookings;
create trigger bookings_guard_client
  before insert on public.bookings
  for each row execute function public.guard_client_booking();

-- ─── Привязка заявки к клиенту ───────────────────────────────────
--  Аноним не имеет и не должен иметь доступа к clients (там телефон
--  и заметка мастера) — привязка идёт через security definer триггер
--  на INSERT bookings, тем же приёмом, что и busy_slots ниже:
--  RLS обходится в одном контролируемом месте, а не открывается клиенту
--  напрямую. Заявка из мини-аппа несёт user_id (аккаунт клиента, его
--  ставит guard_client_booking()) — клиент ищется по нему; нет такого —
--  по telegram_username, чтобы подхватить клиента, которого мастер
--  завела раньше, и тогда ему дописывается user_id; нет и его — заводим
--  нового. Имя — из Telegram, а если его нет — начало e-mail до «@».
--  Строки без user_id (мастер завела сама) — как раньше: по юзернейму,
--  потом по точному имени среди клиентов без юзернейма.
--
--  Имя уже известного клиента НЕ перезаписывается телеграмным: мастер
--  переименовывает клиентов в кабинете, и следующая заявка не должна
--  откатывать её правку. Телеграмное имя берётся, только если своего
--  ещё нет.
--
--  Запись, которую заводит сам мастер (create_master_booking ниже),
--  приходит уже с client_id — её не перепривязываем: совпадение по
--  имени могло бы увести её к однофамильцу. Аноним source = 'master'
--  подставить не может (см. политику bookings_insert_client).
create or replace function public.link_booking_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  found_id bigint;
  mail     text;
begin
  if new.source = 'master' and new.client_id is not null then
    return new;
  end if;

  if new.user_id is not null then
    mail := left(coalesce(auth.jwt() ->> 'email', ''), 254);
    if new.client_name = '' then
      new.client_name := left(split_part(mail, '@', 1), 128);
    end if;

    select id into found_id from public.clients where user_id = new.user_id;
    if found_id is null and new.client_username <> '' then
      update public.clients
         set user_id = new.user_id
       where telegram_username = new.client_username and user_id is null
      returning id into found_id;
    end if;
    if found_id is null then
      insert into public.clients (name, telegram_username, user_id, email)
      values (new.client_name, new.client_username, new.user_id, mail)
      -- юзернейм уже занят клиентом с другим аккаунтом — заводим без него
      on conflict (telegram_username) where telegram_username <> ''
      do nothing
      returning id into found_id;
      if found_id is null then
        insert into public.clients (name, user_id, email)
        values (new.client_name, new.user_id, mail)
        returning id into found_id;
      end if;
    else
      update public.clients
         set name  = case when name = '' then new.client_name else name end,
             email = case when email = '' then mail else email end
       where id = found_id;
    end if;
    new.client_id = found_id;
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

-- ─── is_master(): кто считается мастером ─────────────────────────
--  Роль authenticated — не то же самое, что «мастер»: включённые в
--  дашборде Anonymous Sign-ins тоже выдают authenticated, любому, без
--  пароля. Поэтому каждое право на запись (и на чтение bookings/clients)
--  проверяет эту функцию, а не только роль: пользователь должен быть
--  не анонимным. И с тех пор как клиенты регистрируются сами — ещё и
--  иметь роль 'master' в profiles. Без этой проверки открытая
--  регистрация сделала бы мастером любого клиента.
--
--  ⚠️ Порядок развёртывания: сначала profiles + строка мастера (ниже),
--  потом эта функция, и только потом — включённые Email signups.
--  Роль мастера выдаётся руками, в SQL-редакторе:
--    insert into public.profiles (id, role)
--    select id, 'master' from auth.users where email = '<e-mail мастера>'
--    on conflict (id) do update set role = 'master';
--
--  В политиках вызывается как (select public.is_master()) — так Postgres
--  считает её один раз на запрос, а не на каждую строку. security
--  invoker: свою строку profiles вызывающий читает сам (profiles_select_own).
create or replace function public.is_master()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
     and exists (
       select 1 from public.profiles p
        where p.id = auth.uid() and p.role = 'master'
     )
$$;

grant execute on function public.is_master() to anon, authenticated;

-- ─── profiles: каждый видит и заводит только свою строку ────────────
--  insert — только себе и только 'user': поднять себе роль нельзя.
--  update/delete-политик нет вовсе — роль меняется только из SQL-редактора.
alter table public.profiles enable row level security;

drop policy if exists profiles_select_own  on public.profiles;
drop policy if exists profiles_insert_self on public.profiles;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (
    id = (select auth.uid())
    and role = 'user'
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  );

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
      'create policy %I_insert_auth on public.%I for insert to authenticated with check ((select public.is_master()))', t, t);
    execute format(
      'create policy %I_update_auth on public.%I for update to authenticated using ((select public.is_master())) with check ((select public.is_master()))', t, t);
    execute format(
      'create policy %I_delete_auth on public.%I for delete to authenticated using ((select public.is_master()))', t, t);
  end loop;
end
$$;

-- ═══════════════════════════════════════════════════════════════
--  bookings — иначе, чем остальные таблицы: зарегистрироваться может
--  кто угодно, и открытый select отдал бы имена и комментарии всех
--  клиентов любому. Читает и правит все записи только мастер (кабинет);
--  клиент мини-аппа вставляет свою заявку, читает свои строки
--  (user_id = auth.uid()) и отменяет свою запись (cancel_own_booking).
-- ═══════════════════════════════════════════════════════════════

alter table public.bookings enable row level security;

drop policy if exists bookings_select_auth  on public.bookings;
drop policy if exists bookings_insert_anon  on public.bookings;
drop policy if exists bookings_insert_auth  on public.bookings;
drop policy if exists bookings_update_auth  on public.bookings;
drop policy if exists bookings_delete_auth  on public.bookings;

create policy bookings_select_auth on public.bookings
  for select to authenticated using ((select public.is_master()));

-- Клиент видит только свои строки — те, что оставил со своего аккаунта.
-- Это не «select для authenticated» целиком (тот отдал бы любому
-- зарегистрировавшемуся чужие имена и комментарии): user_id ставит сервер
-- (guard_client_booking), подделать его нельзя. В строке нет ничего,
-- кроме того, что клиент прислал сам, и решения мастера по ней;
-- комментарии мастера о клиенте — в client_comments, туда доступа нет.
drop policy if exists bookings_select_own on public.bookings;
create policy bookings_select_own on public.bookings
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists bookings_insert_client on public.bookings;

-- Клиент мини-аппа создаёт только свою собственную новую заявку —
-- не может подделать статус "ok" или дату задним числом. Дата — по
-- Тбилиси, а не current_date (в базе это UTC), и с запасом в один день:
-- у клиента западнее Тбилиси «сегодня» по часам устройства — ещё
-- вчерашнее по Тбилиси (то же правило в guard_client_booking(), который
-- чистит и проверяет остальное в строке).
-- Мини-апп теперь только для вошедших, так что политика — для
-- authenticated (раньше anon). Политики складываются через OR:
-- bookings_insert_auth мастера рядом работает как прежде.
-- user_id проверяется по строке ПОСЛЕ before-триггеров, то есть после
-- того, как guard_client_booking() записал туда auth.uid().
create policy bookings_insert_client on public.bookings
  for insert to authenticated
  with check (
    status = 'new' and source = 'client'
    and user_id = (select auth.uid())
    and day >= (now() at time zone 'Asia/Tbilisi')::date - 1
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  );

create policy bookings_insert_auth on public.bookings
  for insert to authenticated with check ((select public.is_master()));

create policy bookings_update_auth on public.bookings
  for update to authenticated using ((select public.is_master())) with check ((select public.is_master()));

create policy bookings_delete_auth on public.bookings
  for delete to authenticated using ((select public.is_master()));

-- ─── Устаревшие функции по client_token ──────────────────────────
--  booking_status(uuid[]) и cancel_own_booking(uuid) связывали заявку с
--  копией на устройстве клиента. Теперь клиент читает свои строки сам
--  (bookings_select_own), а отменяет по id — ниже.
drop function if exists public.booking_status(uuid[]);
drop function if exists public.cancel_own_booking(uuid);

-- ─── cancel_own_booking(): клиент отменяет свою запись ──────────────
--  Update-политику клиенту не даём: она открыла бы все колонки строки
--  (статус "ok", день, цену). Здесь security definer меняет ровно три
--  колонки — status, cancelled_by, cancel_seen — и только в строке, чей
--  user_id совпадает с вызывающим. Мастер видит отмену в «Заявках» →
--  «Отмены», окно освобождается для других клиентов.
--  Уже отменённую или прошедшую запись не трогаем (повторный тап —
--  не ошибка, а false).
create or replace function public.cancel_own_booking(p_id bigint)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.bookings b
     set status = 'cancelled',
         cancelled_by = 'client',
         cancel_seen = false
   where b.id = p_id
     and b.user_id = auth.uid()
     and b.status in ('new', 'ok')
     -- today - 1 — то же правило, что у вставки (bookings_insert_client).
     and b.day >= (now() at time zone 'Asia/Tbilisi')::date - 1;
  return found;
end
$$;

-- Функции по умолчанию исполняемы для public — сужаем явно.
revoke all on function public.cancel_own_booking(bigint) from public, anon;
grant execute on function public.cancel_own_booking(bigint) to authenticated;

-- ═══════════════════════════════════════════════════════════════
--  clients — как bookings: телефон и комментарии мастера не должны
--  светиться анониму. anon-политик нет вовсе. Мастер читает, правит
--  и заводит клиентов («Новый клиент» в кабинете); удалять строку
--  напрямую не может никто — у клиента есть история записей. Удаляет
--  клиента только delete_client() — вместе с его записями.
-- ═══════════════════════════════════════════════════════════════

alter table public.clients enable row level security;

drop policy if exists clients_select_auth on public.clients;
drop policy if exists clients_insert_auth on public.clients;
drop policy if exists clients_update_auth on public.clients;

create policy clients_select_auth on public.clients
  for select to authenticated using ((select public.is_master()));

create policy clients_insert_auth on public.clients
  for insert to authenticated with check ((select public.is_master()));

create policy clients_update_auth on public.clients
  for update to authenticated using ((select public.is_master())) with check ((select public.is_master()));

-- ─── client_comments: только мастер ─────────────────────────────

alter table public.client_comments enable row level security;

drop policy if exists client_comments_select_auth on public.client_comments;
drop policy if exists client_comments_insert_auth on public.client_comments;
drop policy if exists client_comments_delete_auth on public.client_comments;

create policy client_comments_select_auth on public.client_comments
  for select to authenticated using ((select public.is_master()));

create policy client_comments_insert_auth on public.client_comments
  for insert to authenticated with check ((select public.is_master()));

create policy client_comments_delete_auth on public.client_comments
  for delete to authenticated using ((select public.is_master()));

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
--  favorite_service_id — самая частая услуга среди ПОДТВЕРЖДЁННЫХ
--  записей клиента (прошлых и будущих; неразобранная заявка — ещё не
--  выбор клиента); название берётся текущее, из services.
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
      and b.status = 'ok' -- неподтверждённая заявка — не визит
      and b.day + make_interval(mins => b.start_min)
          < (now() at time zone 'Asia/Tbilisi')
  ) v on true
  left join lateral (
    select b2.service_id
    from public.bookings b2
    where b2.client_id = c.id and b2.service_id is not null and b2.status = 'ok'
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
          and b.status <> 'cancelled'
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
  -- Отменённую запись сохранение «Изменить» не воскрешает: клиент уже
  -- видит у себя «отменена».
  if bk.status = 'cancelled' then
    raise exception 'Запись уже отменена — обновите страницу';
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
  -- Время не менялось, но сохранение подтверждает заявку: она не должна
  -- лечь поверх уже подтверждённой записи (две заявки клиентов на одно
  -- окно — обычное дело, см. CLAUDE.md).
  if not moved and bk.status <> 'ok' and exists (
    select 1 from public.bookings o
    where o.day = bk.day
      and o.id <> bk.id
      and o.status = 'ok'
      and o.start_min < bk.start_min + bk.duration
      and bk.start_min < o.start_min + o.duration
  ) then
    raise exception 'На это время уже есть подтверждённая запись — выберите другое';
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

-- ─── approve_booking(): «Подтвердить» в «Заявках» ─────────────────
--  Раньше это был голый update status = 'ok' из кабинета — две
--  пересекающиеся заявки подтверждались обе. Теперь подтверждение
--  проверяет, что окно не занято другой ПОДТВЕРЖДЁННОЙ записью, под
--  тем же advisory-локом дня, что create/update_master_booking.
--  Повторное подтверждение — не ошибка.
create or replace function public.approve_booking(p_id bigint)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  bk public.bookings;
begin
  select * into bk from public.bookings b where b.id = p_id;
  if not found then
    raise exception 'Заявка не найдена — обновите страницу';
  end if;

  perform pg_advisory_xact_lock(hashtext('bookings:' || bk.day::text));
  select * into bk from public.bookings b where b.id = p_id for update;
  if not found then
    raise exception 'Заявка не найдена — обновите страницу';
  end if;
  if bk.status = 'ok' then
    return;
  end if;
  if bk.status = 'cancelled' then
    raise exception 'Клиент уже отменил эту заявку — обновите страницу';
  end if;

  if exists (
    select 1 from public.bookings o
    where o.day = bk.day
      and o.id <> bk.id
      and o.status = 'ok'
      and o.start_min < bk.start_min + bk.duration
      and bk.start_min < o.start_min + o.duration
  ) then
    raise exception 'На это время уже есть подтверждённая запись — перенесите заявку через «Изменить»';
  end if;

  update public.bookings b set status = 'ok' where b.id = p_id;
end
$$;

revoke all on function public.approve_booking(bigint) from public, anon;
grant execute on function public.approve_booking(bigint) to authenticated;

-- ─── delete_client(): «Удалить клиента» вместе со всем, что к нему ─
--  привязано. Записи (прошлые, будущие и неподтверждённые заявки) и
--  комментарии уходят в той же транзакции, что и карточка. Каскадом
--  по внешнему ключу этого не сделать: bookings.client_id — on delete
--  set null, и так и должно остаться для всех прочих путей, иначе
--  записи тихо пропадали бы из расписания.
--
--  security definer: прямого delete-права на clients нет ни у кого
--  (см. RLS clients выше) — удалить клиента можно только так, целиком,
--  а не оставив его записи сиротами. Исполнять может только
--  authenticated, как и остальные функции мастера.
--
--  Идемпотентна: уже удалённый клиент — не ошибка, а нули в ответе
--  (второй тап или вторая вкладка кабинета).
--
--  Больше к клиенту ничего не привязано: visit_count, last_visit_at и
--  любимая услуга — это вьюха client_stats, она пересчитывается сама.
create or replace function public.delete_client(p_id bigint)
returns table (bookings_deleted integer, comments_deleted integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  nb integer := 0;
  nc integer := 0;
begin
  -- security definer обходит RLS — право проверяем сами, как политики.
  if not public.is_master() then
    raise exception 'Нет доступа';
  end if;

  -- Блокировка строки: заявка, которую link_booking_client() сейчас
  -- привязывает к этому клиенту, дождётся конца транзакции и не
  -- проскочит мимо удаления.
  perform 1 from public.clients c where c.id = p_id for update;
  if not found then
    return query select 0, 0;
    return;
  end if;

  delete from public.bookings b where b.client_id = p_id;
  get diagnostics nb = row_count;
  delete from public.client_comments cm where cm.client_id = p_id;
  get diagnostics nc = row_count;
  delete from public.clients c where c.id = p_id;

  return query select nb, nc;
end
$$;

revoke all on function public.delete_client(bigint) from public, anon;
grant execute on function public.delete_client(bigint) to authenticated;

-- ─── blocked_slots: читают все (это часть доступности), пишет мастер ──

alter table public.blocked_slots enable row level security;

drop policy if exists blocked_slots_select_public on public.blocked_slots;
drop policy if exists blocked_slots_insert_auth   on public.blocked_slots;
drop policy if exists blocked_slots_delete_auth   on public.blocked_slots;

create policy blocked_slots_select_public on public.blocked_slots
  for select to anon, authenticated using (true);

create policy blocked_slots_insert_auth on public.blocked_slots
  for insert to authenticated with check ((select public.is_master()));

create policy blocked_slots_delete_auth on public.blocked_slots
  for delete to authenticated using ((select public.is_master()));

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
--  Прошлое отрезано в самой вьюхе: клиенту оно не нужно, а без фильтра
--  анонимный ключ читал бы всю историю занятости салона.
--  Отменённые записи окно не занимают.
create or replace view public.busy_slots
  with (security_invoker = off) as
  select day, start_min, duration from public.bookings
    where day >= (now() at time zone 'Asia/Tbilisi')::date
      and status <> 'cancelled'
  union all
  select day, start_min, 0 as duration from public.blocked_slots
    where day >= (now() at time zone 'Asia/Tbilisi')::date;

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
--  Новая функция (cancel_own_booking) и новая колонка не видны через REST,
--  пока PostgREST не перечитает схему. Supabase обычно делает это сам,
--  но при повторном прогоне файла на живой базе дешевле сказать явно —
--  иначе первый вызов rpc() вернёт «function not found».
notify pgrst, 'reload schema';
