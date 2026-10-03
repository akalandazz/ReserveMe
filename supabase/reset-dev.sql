-- ═══════════════════════════════════════════════════════════════
--  ⚠️ ТОЛЬКО ДЛЯ РАЗРАБОТКИ. Стирает всех пользователей и все записи.
--
--  Переход с входа по e-mail на вход через Telegram: старые аккаунты
--  (с паролями) не привязаны к Telegram user id, а пароль у них
--  по-прежнему работает через Auth API. Их не переносим, а удаляем
--  целиком — вместе с клиентами и записями, которые на них ссылаются.
--
--  Порядок: этот файл → supabase/schema.sql → мастер входит в кабинет
--  из Telegram → роль мастера руками (сниппет над is_master() в schema.sql).
--
--  Контент салона (settings, services, days_off, info_blocks,
--  blocked_slots) не трогается.
-- ═══════════════════════════════════════════════════════════════

begin;

delete from public.client_comments;
delete from public.bookings;
delete from public.clients;
-- Таблицы может ещё не быть (база до profiles).
do $$
begin
  if to_regclass('public.profiles') is not null then
    delete from public.profiles;
  end if;
end
$$;
-- Сессии, refresh-токены и identities уходят каскадом.
delete from auth.users;

commit;
