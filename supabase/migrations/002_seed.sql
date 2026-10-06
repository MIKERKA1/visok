-- Демо-данные. Все люди, телефоны и отзывы вымышлены.
-- Записи считаются от текущей даты, чтобы демо всегда выглядело живым.

insert into public.settings (id, timezone) values (true, 'Europe/Moscow');
insert into public.admins (email) values ('jkak527@gmail.com');

insert into public.services (name, description, price, duration_min, sort_order) values
  ('Мужская стрижка',      'Ножницы и машинка, мытьё головы, укладка. Покажем, как укладывать дома.', 2200, 60, 1),
  ('Фейд',                 'Плавный переход от кожи, верх ножницами.',                               2500, 60, 2),
  ('Стрижка машинкой',     'Одна-две насадки и окантовка.',                                          1300, 30, 3),
  ('Моделирование бороды', 'Форма, контур опасной бритвой, масло.',                                  1500, 45, 4),
  ('Стрижка и борода',     'Обе услуги за один визит, на 300 ₽ дешевле, чем по отдельности.',        3400, 90, 5),
  ('Королевское бритьё',   'Горячее полотенце, пена помазком, опасная бритва.',                      1900, 45, 6),
  ('Детская стрижка',      'До 12 лет. Не торопимся, можно с мультиками.',                           1500, 45, 7),
  ('Камуфляж седины',      'Тонирование: седина уходит наполовину, держится 4–6 недель.',            1400, 30, 8);

insert into public.masters (name, photo_url, specialization, experience_years, bio, sort_order) values
  ('Артём Ковалёв', 'img/master-1.webp', 'Классика, борода, опасная бритва', 9,
   'Начинал в маленькой парикмахерской на Лиговском. Любит длинные стрижки ножницами и бритьё по старинке.', 1),
  ('Тимур Хасанов', 'img/master-2.webp', 'Фейды и короткие стрижки', 6,
   'Делает переходы так, что линии не видно. Если не знаете, что хотите, принесите фото, разберётся.', 2),
  ('Мирон Белов',   'img/master-3.webp', 'Детские стрижки, камуфляж седины', 4,
   'Стрижёт детей с трёх лет и не нервничает, когда они крутятся. Взрослым подбирает тон для седины.', 3);

insert into public.master_services (master_id, service_id)
select m.id, s.id from public.masters m join public.services s on
  (m.name = 'Артём Ковалёв' and s.sort_order in (1, 2, 4, 5, 6, 8)) or
  (m.name = 'Тимур Хасанов' and s.sort_order in (1, 2, 3, 4, 5)) or
  (m.name = 'Мирон Белов'   and s.sort_order in (1, 2, 3, 7, 8));

-- Артём: вт–сб 11–21. Тимур: пн–пт 10–20 с перерывом 14–15. Мирон: ср–вс 10–21.
insert into public.working_hours (master_id, weekday, start_time, end_time)
select m.id, w.d, w.s, w.e from public.masters m
join (values
  ('Артём Ковалёв', 2, '11:00'::time, '21:00'::time), ('Артём Ковалёв', 3, '11:00', '21:00'), ('Артём Ковалёв', 4, '11:00', '21:00'),
  ('Артём Ковалёв', 5, '11:00', '21:00'), ('Артём Ковалёв', 6, '11:00', '21:00'),
  ('Тимур Хасанов', 1, '10:00', '14:00'), ('Тимур Хасанов', 1, '15:00', '20:00'),
  ('Тимур Хасанов', 2, '10:00', '14:00'), ('Тимур Хасанов', 2, '15:00', '20:00'),
  ('Тимур Хасанов', 3, '10:00', '14:00'), ('Тимур Хасанов', 3, '15:00', '20:00'),
  ('Тимур Хасанов', 4, '10:00', '14:00'), ('Тимур Хасанов', 4, '15:00', '20:00'),
  ('Тимур Хасанов', 5, '10:00', '14:00'), ('Тимур Хасанов', 5, '15:00', '20:00'),
  ('Мирон Белов', 3, '10:00', '21:00'), ('Мирон Белов', 4, '10:00', '21:00'), ('Мирон Белов', 5, '10:00', '21:00'),
  ('Мирон Белов', 6, '10:00', '21:00'), ('Мирон Белов', 7, '10:00', '21:00')
) as w(name, d, s, e) on w.name = m.name;

insert into public.days_off (master_id, day, reason)
select id, (now() at time zone 'Europe/Moscow')::date + 8, 'Учёба' from public.masters where name = 'Мирон Белов';

-- Записи: с -3 по +6 день, только в рабочие часы мастера.
with base as (select (now() at time zone 'Europe/Moscow')::date as today),
plan (day_off, master, at_time, service_order, client, phone, src) as (values
  (-3, 'Артём Ковалёв', '12:00'::time, 5, 'Глеб',      '+79990000101', 'site'),
  (-3, 'Тимур Хасанов', '16:00',       2, 'Никита',    '+79990000102', 'site'),
  (-2, 'Мирон Белов',   '11:00',       7, 'Анна',      '+79990000103', 'admin'),
  (-2, 'Артём Ковалёв', '17:00',       6, 'Сергей',    '+79990000104', 'site'),
  (-1, 'Тимур Хасанов', '12:00',       3, 'Олег',      '+79990000105', 'site'),
  (-1, 'Мирон Белов',   '18:00',       8, 'Павел',     '+79990000106', 'site'),
  ( 0, 'Артём Ковалёв', '18:00',       1, 'Илья',      '+79990000107', 'site'),
  ( 0, 'Тимур Хасанов', '17:00',       2, 'Руслан',    '+79990000108', 'admin'),
  ( 0, 'Мирон Белов',   '19:00',       1, 'Константин','+79990000109', 'site'),
  ( 1, 'Артём Ковалёв', '13:00',       4, 'Максим',    '+79990000110', 'site'),
  ( 1, 'Тимур Хасанов', '11:00',       5, 'Владимир',  '+79990000111', 'site'),
  ( 1, 'Мирон Белов',   '15:00',       7, 'Мария',     '+79990000112', 'site'),
  ( 2, 'Артём Ковалёв', '16:00',       6, 'Георгий',   '+79990000113', 'site'),
  ( 2, 'Мирон Белов',   '12:00',       3, 'Тихон',     '+79990000114', 'admin'),
  ( 3, 'Тимур Хасанов', '18:00',       1, 'Артур',     '+79990000115', 'site'),
  ( 4, 'Артём Ковалёв', '19:00',       5, 'Степан',    '+79990000116', 'site'),
  ( 5, 'Мирон Белов',   '14:00',       8, 'Борис',     '+79990000117', 'site'),
  ( 6, 'Тимур Хасанов', '10:00',       2, 'Ян',        '+79990000118', 'site')
),
rows as (
  select m.id as master_id, s.id as service_id, p.client, p.phone, p.src, p.day_off,
         ((b.today + p.day_off) + p.at_time) as local_start, s.duration_min
  from plan p cross join base b
  join public.masters m on m.name = p.master
  join public.services s on s.sort_order = p.service_order
  where exists (
    select 1 from public.working_hours wh
    where wh.master_id = m.id
      and wh.weekday = extract(isodow from b.today + p.day_off)
      and p.at_time >= wh.start_time
      and p.at_time + make_interval(mins => s.duration_min) <= wh.end_time)
)
insert into public.bookings (master_id, service_id, starts_at, ends_at, client_name, client_phone, status, source)
select master_id, service_id,
       local_start at time zone 'Europe/Moscow',
       (local_start + make_interval(mins => duration_min)) at time zone 'Europe/Moscow',
       client, phone,
       (case when local_start < (now() at time zone 'Europe/Moscow') then
               case when client = 'Олег' then 'no_show' else 'done' end
             when day_off <= 1 then 'confirmed' else 'new' end)::public.booking_status,
       src::public.booking_source
from rows;

insert into public.gallery (image_url, caption, master_id, sort_order)
select g.url, g.caption, m.id, g.ord from (values
  ('img/work-3.webp', 'Фейд с нуля, верх ножницами',     'Тимур Хасанов', 1),
  ('img/work-2.webp', 'Борода: форма и контур',           'Артём Ковалёв', 2),
  ('img/work-1.webp', 'Андеркат и укладка на матовую пасту', 'Тимур Хасанов', 3),
  ('img/work-6.webp', 'Бритьё с горячим полотенцем',      'Артём Ковалёв', 4),
  ('img/work-5.webp', 'Детская стрижка, 9 лет',           'Мирон Белов',   5),
  ('img/work-4.webp', 'Помпадур, укладка феном',          'Мирон Белов',   6),
  ('img/work-7.webp', 'Длина ножницами по расчёске',      'Артём Ковалёв', 7),
  ('img/work-8.webp', 'Короткий кроп машинкой',           'Тимур Хасанов', 8)
) as g(url, caption, master, ord)
left join public.masters m on m.name = g.master;

insert into public.reviews (author_name, text, rating, sort_order) values
  ('Глеб',   'Третий год хожу к Артёму. Он помнит, как стриг в прошлый раз, ничего объяснять не надо.', 5, 1),
  ('Сергей', 'Записался вечером на сайте на утро. Через сорок минут уже вышел. Кофе, кстати, тоже нормальный.', 5, 2),
  ('Анна',   'Сын боялся машинки. Мирон дал её подержать и показал, как она жужжит, дальше всё прошло спокойно.', 5, 3),
  ('Павел',  'Камуфляж седины выглядит естественно, жена неделю не замечала. Минус один: парковка у входа всегда занята.', 4, 4);
