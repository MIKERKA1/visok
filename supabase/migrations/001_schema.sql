-- Барбершоп: схема для сайта, админки и будущего Telegram-бота.
-- Время записей хранится в UTC (timestamptz), график мастеров — в местном времени заведения (settings.timezone).

create extension if not exists btree_gist with schema extensions;

-- Настройки заведения: одна строка.
create table public.settings (
  id boolean primary key default true check (id),
  timezone text not null default 'Europe/Moscow',
  slot_step_min int not null default 15 check (slot_step_min between 5 and 120),
  min_lead_min int not null default 60 check (min_lead_min >= 0),   -- за сколько минут до начала ещё можно записаться
  horizon_days int not null default 30 check (horizon_days between 1 and 120)
);

create table public.admins (
  email text primary key check (email = lower(email))
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  description text check (char_length(description) <= 300),
  price int not null check (price >= 0),
  duration_min int not null check (duration_min between 5 and 480),
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.masters (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  photo_url text,
  specialization text check (char_length(specialization) <= 120),
  experience_years int check (experience_years between 0 and 70),
  bio text check (char_length(bio) <= 600),
  is_active boolean not null default true,
  sort_order int not null default 0,
  telegram_chat_id bigint,          -- куда бот шлёт мастеру уведомления о записях
  created_at timestamptz not null default now()
);

create table public.master_services (
  master_id uuid not null references public.masters on delete cascade,
  service_id uuid not null references public.services on delete cascade,
  primary key (master_id, service_id)
);
create index on public.master_services (service_id);

-- Несколько строк на один день = рабочие интервалы с перерывом.
create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  master_id uuid not null references public.masters on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),  -- ISO: 1 = понедельник
  start_time time not null,
  end_time time not null,
  check (end_time > start_time)
);
create index on public.working_hours (master_id, weekday);

-- master_id = null — выходной у всего заведения.
create table public.days_off (
  id uuid primary key default gen_random_uuid(),
  master_id uuid references public.masters on delete cascade,
  day date not null,
  reason text check (char_length(reason) <= 120),
  unique nulls not distinct (master_id, day)
);

create type public.booking_status as enum ('new', 'confirmed', 'cancelled', 'done', 'no_show');
create type public.booking_source as enum ('site', 'bot', 'admin');

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  master_id uuid not null references public.masters on delete restrict,
  service_id uuid not null references public.services on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  client_name text not null check (char_length(client_name) between 2 and 80),
  client_phone text not null check (client_phone ~ '^\+\d{11,15}$'),
  comment text check (char_length(comment) <= 500),
  status public.booking_status not null default 'new',
  source public.booking_source not null default 'site',
  client_telegram_id bigint,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  -- Двойная запись к одному мастеру невозможна на уровне БД. Отменённые не занимают время.
  constraint bookings_no_overlap exclude using gist (
    master_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status <> 'cancelled')
);
create index on public.bookings (starts_at);
create index on public.bookings (client_phone, created_at);
create index on public.bookings (client_telegram_id) where client_telegram_id is not null;

create table public.gallery (
  id uuid primary key default gen_random_uuid(),
  image_url text not null,
  caption text check (char_length(caption) <= 120),
  master_id uuid references public.masters on delete set null,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  author_name text not null check (char_length(author_name) between 1 and 60),
  text text not null check (char_length(text) between 1 and 600),
  rating smallint not null default 5 check (rating between 1 and 5),
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- ─── Права ───────────────────────────────────────────────────────────────

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where email = lower(auth.jwt() ->> 'email'));
$$;

alter table public.settings        enable row level security;
alter table public.admins          enable row level security;
alter table public.services        enable row level security;
alter table public.masters         enable row level security;
alter table public.master_services enable row level security;
alter table public.working_hours   enable row level security;
alter table public.days_off        enable row level security;
alter table public.bookings        enable row level security;
alter table public.gallery         enable row level security;
alter table public.reviews         enable row level security;

-- anon только читает и только нужное: записи и график закрыты полностью.
revoke all on all tables in schema public from anon;
grant select on public.settings, public.services, public.master_services, public.gallery, public.reviews to anon;
grant select (id, name, photo_url, specialization, experience_years, bio, is_active, sort_order) on public.masters to anon;

create policy "public read" on public.settings for select using (true);
create policy "public read active" on public.services for select using (is_active or public.is_admin());
create policy "public read active" on public.masters  for select using (is_active or public.is_admin());
create policy "public read active" on public.gallery  for select using (is_active or public.is_admin());
create policy "public read active" on public.reviews  for select using (is_active or public.is_admin());
create policy "public read" on public.master_services for select using (true);

-- Админ правит всё. Записи создаются только через create_booking (insert-политики нет).
create policy "admin write" on public.settings        for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin write" on public.services        for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin write" on public.masters         for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin write" on public.master_services for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin all"   on public.working_hours   for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin all"   on public.days_off        for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin write" on public.gallery         for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin write" on public.reviews         for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin read"   on public.bookings for select to authenticated using (public.is_admin());
create policy "admin update" on public.bookings for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin delete" on public.bookings for delete to authenticated using (public.is_admin());
revoke insert on public.bookings from authenticated;

-- ─── Свободные слоты ─────────────────────────────────────────────────────
-- Возвращает (мастер, начало) на p_days дней начиная с p_from (по местному времени заведения).
-- Учитывает график, выходные, длительность услуги, занятые записи и минимальный запас до начала.

create function public.get_free_slots(
  p_service_id uuid,
  p_master_id uuid default null,
  p_from date default null,
  p_days int default 14
) returns table (master_id uuid, starts_at timestamptz)
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
        and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(c.starts_at, c.ends_at, '[)'))
  order by c.starts_at, c.master_id;
$$;

-- ─── Создание записи: одна функция для сайта, бота и админки ─────────────
-- source = 'site'  — anon с сайта: проверка графика, лимиты по телефону, honeypot.
-- source = 'bot'   — только service_role (сервер бота): те же проверки + client_telegram_id.
-- source = 'admin' — только админ: можно вне графика и задним числом, пересечения всё равно запрещены.

create function public.create_booking(
  p_service_id uuid,
  p_starts_at timestamptz,
  p_client_name text,
  p_client_phone text,
  p_master_id uuid default null,          -- null = «любой свободный»
  p_comment text default null,
  p_source public.booking_source default 'site',
  p_client_telegram_id bigint default null,
  p_website text default null             -- honeypot: люди это поле не видят
) returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  v_phone text := regexp_replace(coalesce(p_client_phone, ''), '\D', '', 'g');
  v_name text := btrim(coalesce(p_client_name, ''));
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_tz text;
  v_dur int;
  v_master uuid;
  v_id uuid;
begin
  if coalesce(p_website, '') <> '' then
    raise exception 'spam_detected';
  end if;
  if p_source = 'admin' and not public.is_admin() then
    raise exception 'forbidden_source';
  end if;
  if p_source = 'bot' and coalesce(auth.role(), '') <> 'service_role' then
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
    -- ponytail: лимит по телефону, не по IP; для IP-лимита нужен прокси или Edge Function перед RPC.
    if (select count(*) from bookings where client_phone = v_phone and created_at > now() - interval '1 hour') >= 3
       or (select count(*) from bookings where client_phone = v_phone and status in ('new', 'confirmed') and starts_at > now()) >= 3 then
      raise exception 'too_many_bookings';
    end if;
    if p_starts_at <= now() then raise exception 'time_in_past'; end if;

    -- Слот должен быть среди свободных: это заодно проверяет график, выходные и запас по времени.
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

revoke execute on function public.get_free_slots(uuid, uuid, date, int) from public;
revoke execute on function public.create_booking(uuid, timestamptz, text, text, uuid, text, public.booking_source, bigint, text) from public;
grant execute on function public.get_free_slots(uuid, uuid, date, int) to anon, authenticated, service_role;
grant execute on function public.create_booking(uuid, timestamptz, text, text, uuid, text, public.booking_source, bigint, text) to anon, authenticated, service_role;

-- Новые записи прилетают в админку и боту через Realtime.
alter publication supabase_realtime add table public.bookings;

-- ─── Хранилище фото ──────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "admin upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.is_admin());
create policy "admin update" on storage.objects for update to authenticated
  using (bucket_id = 'media' and public.is_admin());
create policy "admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.is_admin());
