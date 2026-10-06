-- Telegram-бот. Только добавления: сайт продолжает работать как раньше.
-- Две функции (get_free_slots, create_booking) пересоздаются с той же сигнатурой и тем же поведением для сайта,
-- в них добавлены проверки для бота: закрытое мастером время, блокировка клиента, лимит записей в сутки.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ─── Новые поля ──────────────────────────────────────────────────────────
alter table public.settings
  add column bot_function_url text,                        -- адрес Edge Function бота; null = бот выключен, триггеры молчат
  add column bot_username text,                            -- для ссылок t.me/<username> в админке сайта
  add column bot_daily_limit int not null default 3 check (bot_daily_limit between 1 and 50);

alter table public.reviews
  add column source text not null default 'admin' check (source in ('admin', 'bot')),
  add column booking_id uuid references public.bookings on delete set null;

-- ─── Новые таблицы ───────────────────────────────────────────────────────
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique,
  name text check (char_length(name) <= 80),
  phone text check (phone ~ '^\+\d{11,15}$'),
  notifications_enabled boolean not null default true,
  blocked boolean not null default false,
  blocked_reason text check (char_length(blocked_reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.clients (phone);

create table public.bot_admins (
  telegram_id bigint primary key,
  name text,
  created_at timestamptz not null default now()
);

-- Одноразовый код привязки мастера: админ получает его на сайте, мастер открывает ссылку t.me/<bot>?start=m_<код>.
create table public.master_link_codes (
  code text primary key,
  master_id uuid not null references public.masters on delete cascade,
  expires_at timestamptz not null default now() + interval '30 minutes',
  used_at timestamptz
);

-- Чтобы напоминание и просьба об отзыве не ушли дважды.
create table public.reminders_sent (
  booking_id uuid not null references public.bookings on delete cascade,
  kind text not null check (kind in ('24h', '2h', 'review')),
  sent_at timestamptz not null default now(),
  primary key (booking_id, kind)
);

-- Идемпотентность: повторно доставленный update не обрабатывается.
create table public.processed_updates (
  update_id bigint primary key,
  processed_at timestamptz not null default now()
);

-- Состояние диалога (какой шаг записи, что выбрано). Edge Function не хранит память между запросами.
create table public.bot_sessions (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Закрытое мастером время внутри рабочего дня («обед», «к врачу»). Целый день закрывается через days_off.
create table public.time_blocks (
  id uuid primary key default gen_random_uuid(),
  master_id uuid not null references public.masters on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text check (char_length(reason) <= 120),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index on public.time_blocks (master_id, starts_at);

-- ─── Права ───────────────────────────────────────────────────────────────
-- Бот ходит с service_role и RLS не замечает. anon в новые таблицы не пускаем вообще.
alter table public.clients           enable row level security;
alter table public.bot_admins        enable row level security;
alter table public.master_link_codes enable row level security;
alter table public.reminders_sent    enable row level security;
alter table public.processed_updates enable row level security;
alter table public.bot_sessions      enable row level security;
alter table public.time_blocks       enable row level security;
revoke all on public.clients, public.bot_admins, public.master_link_codes, public.reminders_sent,
  public.processed_updates, public.bot_sessions, public.time_blocks from anon;

-- Админ сайта видит клиентов (и может заблокировать), закрытое время и список админов бота.
create policy "admin all" on public.clients     for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin all" on public.time_blocks for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin all" on public.bot_admins  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ─── Свободные слоты: общая логика + учёт закрытого времени ─────────────
-- p_ignore_booking нужен переносу: собственная запись клиента не мешает сдвинуть её на 15 минут.
create function public._free_slots(p_service_id uuid, p_master_id uuid, p_from date, p_days int, p_ignore_booking uuid)
returns table (master_id uuid, starts_at timestamptz)
language sql stable security definer set search_path = public as $$
  with s as (select * from settings where id),
  svc as (select id, duration_min from services where id = p_service_id and is_active),
  days as (
    select g::date as day
    from s, generate_series(
      coalesce(p_from, (now() at time zone s.timezone)::date),
      coalesce(p_from, (now() at time zone s.timezone)::date) + (least(greatest(p_days, 1), 62) - 1),
      interval '1 day') g
  ),
  cand as (
    select m.id as master_id,
           t.local_start at time zone s.timezone as starts_at,
           (t.local_start + make_interval(mins => svc.duration_min)) at time zone s.timezone as ends_at
    from s
    cross join svc
    cross join days d
    join masters m on m.is_active and (p_master_id is null or m.id = p_master_id)
    join master_services ms on ms.master_id = m.id and ms.service_id = svc.id
    join working_hours wh on wh.master_id = m.id and wh.weekday = extract(isodow from d.day)
    cross join lateral generate_series(
      d.day + wh.start_time,
      d.day + wh.end_time - make_interval(mins => svc.duration_min),
      make_interval(mins => s.slot_step_min)) as t(local_start)
    where not exists (
      select 1 from days_off o where o.day = d.day and (o.master_id = m.id or o.master_id is null))
  )
  select c.master_id, c.starts_at
  from cand c, s
  where c.starts_at >= now() + make_interval(mins => s.min_lead_min)
    and c.starts_at < now() + make_interval(days => s.horizon_days)
    and not exists (
      select 1 from bookings b
      where b.master_id = c.master_id and b.status <> 'cancelled'
        and (p_ignore_booking is null or b.id <> p_ignore_booking)
        and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(c.starts_at, c.ends_at, '[)'))
    and not exists (
      select 1 from time_blocks tb
      where tb.master_id = c.master_id
        and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(c.starts_at, c.ends_at, '[)'))
  order by c.starts_at, c.master_id;
$$;
revoke execute on function public._free_slots(uuid, uuid, date, int, uuid) from public, anon, authenticated;

create or replace function public.get_free_slots(
  p_service_id uuid,
  p_master_id uuid default null,
  p_from date default null,
  p_days int default 14
) returns table (master_id uuid, starts_at timestamptz)
language sql stable security definer set search_path = public as $$
  select * from public._free_slots(p_service_id, p_master_id, p_from, p_days, null);
$$;

-- ─── Создание записи: + блокировка клиента, + лимит в сутки для бота, + админ из бота ─
create or replace function public.create_booking(
  p_service_id uuid,
  p_starts_at timestamptz,
  p_client_name text,
  p_client_phone text,
  p_master_id uuid default null,
  p_comment text default null,
  p_source public.booking_source default 'site',
  p_client_telegram_id bigint default null,
  p_website text default null
) returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  v_phone text := regexp_replace(coalesce(p_client_phone, ''), '\D', '', 'g');
  v_name text := btrim(coalesce(p_client_name, ''));
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_service_role boolean := coalesce(auth.role(), '') = 'service_role';
  v_tz text;
  v_dur int;
  v_master uuid;
  v_id uuid;
begin
  if coalesce(p_website, '') <> '' then
    raise exception 'spam_detected';
  end if;
  -- Ручную запись делает админ сайта или админ бота (роль бот проверяет сам и ходит с service_role).
  if p_source = 'admin' and not (public.is_admin() or v_service_role) then
    raise exception 'forbidden_source';
  end if;
  if p_source = 'bot' and not v_service_role then
    raise exception 'forbidden_source';
  end if;

  if char_length(v_name) not between 2 and 80 then raise exception 'invalid_name'; end if;
  if length(v_phone) = 11 and left(v_phone, 1) = '8' then v_phone := '7' || substr(v_phone, 2); end if;
  if length(v_phone) = 10 and left(v_phone, 1) = '9' then v_phone := '7' || v_phone; end if;
  if length(v_phone) not between 11 and 15 then raise exception 'invalid_phone'; end if;
  v_phone := '+' || v_phone;
  if char_length(coalesce(v_comment, '')) > 500 then raise exception 'comment_too_long'; end if;
  if p_starts_at is null then raise exception 'invalid_time'; end if;

  select duration_min into v_dur from services where id = p_service_id and is_active;
  if v_dur is null then raise exception 'invalid_service'; end if;
  select timezone into v_tz from settings where id;

  if p_source = 'admin' then
    v_master := p_master_id;
    if v_master is null then raise exception 'master_required'; end if;
  else
    if exists (select 1 from clients where blocked
               and ((p_client_telegram_id is not null and telegram_id = p_client_telegram_id) or phone = v_phone)) then
      raise exception 'client_blocked';
    end if;
    -- ponytail: лимит по телефону и аккаунту Telegram, не по IP; для IP нужен прокси перед RPC.
    if (select count(*) from bookings where client_phone = v_phone and created_at > now() - interval '1 hour') >= 3
       or (select count(*) from bookings where client_phone = v_phone and status in ('new', 'confirmed') and starts_at > now()) >= 3
       or (p_client_telegram_id is not null and (select count(*) from bookings
             where client_telegram_id = p_client_telegram_id and created_at > now() - interval '1 day')
           >= (select bot_daily_limit from settings where id)) then
      raise exception 'too_many_bookings';
    end if;
    if p_starts_at <= now() then raise exception 'time_in_past'; end if;

    select f.master_id into v_master
    from public.get_free_slots(p_service_id, p_master_id, (p_starts_at at time zone v_tz)::date, 1) f
    where f.starts_at = p_starts_at
    order by random()
    limit 1;
    if v_master is null then raise exception 'slot_unavailable'; end if;
  end if;

  begin
    insert into bookings (master_id, service_id, starts_at, ends_at, client_name, client_phone, comment, source, client_telegram_id)
    values (v_master, p_service_id, p_starts_at, p_starts_at + make_interval(mins => v_dur),
            v_name, v_phone, v_comment, p_source, p_client_telegram_id)
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'slot_taken';
  end;

  return json_build_object(
    'id', v_id,
    'master_id', v_master,
    'master_name', (select name from masters where id = v_master),
    'starts_at', p_starts_at,
    'ends_at', p_starts_at + make_interval(mins => v_dur)
  );
end;
$$;

-- ─── Перенос записи (только бот) ─────────────────────────────────────────
create function public.reschedule_booking(p_booking_id uuid, p_new_starts_at timestamptz)
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  b bookings;
  v_tz text;
  v_dur int;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null or b.status not in ('new', 'confirmed') then raise exception 'booking_not_active'; end if;
  if b.starts_at <= now() then raise exception 'booking_started'; end if;
  select timezone into v_tz from settings where id;
  select duration_min into v_dur from services where id = b.service_id;
  if not exists (
    select 1 from public._free_slots(b.service_id, b.master_id, (p_new_starts_at at time zone v_tz)::date, 1, b.id) f
    where f.starts_at = p_new_starts_at) then
    raise exception 'slot_unavailable';
  end if;
  begin
    update bookings set starts_at = p_new_starts_at, ends_at = p_new_starts_at + make_interval(mins => v_dur) where id = b.id;
  exception when exclusion_violation then
    raise exception 'slot_taken';
  end;
  delete from reminders_sent where booking_id = b.id and kind in ('24h', '2h');
  return json_build_object('id', b.id, 'old_starts_at', b.starts_at, 'starts_at', p_new_starts_at);
end;
$$;
revoke execute on function public.reschedule_booking(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.reschedule_booking(uuid, timestamptz) to service_role;

-- ─── Код привязки мастера (кнопка в админке сайта) ──────────────────────
create function public.create_master_link_code(p_master_id uuid) returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_code text := upper(encode(gen_random_bytes(5), 'hex'));
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  delete from master_link_codes where master_id = p_master_id or expires_at < now();
  insert into master_link_codes (code, master_id) values (v_code, p_master_id);
  return v_code;
end;
$$;
revoke execute on function public.create_master_link_code(uuid) from public, anon;
grant execute on function public.create_master_link_code(uuid) to authenticated;

-- ─── Секреты между базой и ботом (генерируются здесь, никто их не вводит руками) ─
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'bot_internal_secret', 'Заголовок x-internal-secret: база → бот');
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'bot_webhook_secret', 'secret_token вебхука Telegram');

create function public.bot_secrets() returns json
language sql stable security definer set search_path = public as $$
  select json_object_agg(name, decrypted_secret) from vault.decrypted_secrets
  where name in ('bot_internal_secret', 'bot_webhook_secret');
$$;
revoke execute on function public.bot_secrets() from public, anon, authenticated;
grant execute on function public.bot_secrets() to service_role;

-- Вызов бота из базы: триггер, cron, первичная настройка вебхука.
create function public.bot_call(p_path text, p_body jsonb default '{}') returns bigint
language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_url text := (select bot_function_url from settings where id);
begin
  if v_url is null then return null; end if;
  return net.http_post(
    url := v_url || '/' || p_path,
    body := p_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bot_internal_secret')),
    timeout_milliseconds := 10000);
end;
$$;
revoke execute on function public.bot_call(text, jsonb) from public, anon, authenticated;

-- ─── Уведомления о записях с любого источника ────────────────────────────
create function public.bookings_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.status = old.status and new.starts_at = old.starts_at and new.master_id = old.master_id then
    return new;
  end if;
  perform public.bot_call('notify', jsonb_build_object(
    'op', tg_op, 'record', to_jsonb(new), 'old', case when tg_op = 'UPDATE' then to_jsonb(old) end));
  return new;
end;
$$;
create trigger bookings_notify after insert or update on public.bookings
  for each row execute function public.bookings_notify();

-- ─── Плановые задачи ─────────────────────────────────────────────────────
-- Раз в 5 минут: напоминания за 24 ч и 2 ч, просьба об отзыве после визита.
select cron.schedule('bot-tick', '*/5 * * * *', $$select public.bot_call('cron')$$);
-- Раз в сутки: чистка служебных таблиц.
select cron.schedule('bot-cleanup', '17 3 * * *', $$
  delete from public.processed_updates where processed_at < now() - interval '3 days';
  delete from public.bot_sessions where updated_at < now() - interval '30 days';
  delete from public.master_link_codes where expires_at < now() - interval '1 day';
$$);
