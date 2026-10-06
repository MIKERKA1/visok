-- Интеграционные проверки логики записи для бота. Всё в транзакции и откатывается.
-- Запуск: Supabase → SQL Editor (или MCP execute_sql). Результат: таблица «проверка → ok/FAIL».
begin;
create temp table t(name text, ok boolean, detail text);

do $$
declare
  svc uuid := (select id from services where name = 'Стрижка машинкой');   -- 30 минут
  m uuid := (select id from masters where name = 'Тимур Хасанов');
  s1 timestamptz; s2 timestamptz;
  b1 json; b2 json; r text;
  tg bigint := 900000001;
begin
  -- Как ходит бот: роль service_role.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- Лимит в сутки поднимем на время проверок двойной записи, отдельно проверим ниже.
  update settings set bot_daily_limit = 10;

  -- Два свободных слота у Тимура в разные дни.
  select starts_at into s1 from get_free_slots(svc, m, null, 14) where starts_at > now() + interval '1 day' order by starts_at limit 1;
  select starts_at into s2 from get_free_slots(svc, m, null, 14)
    where (starts_at at time zone 'Europe/Moscow')::date > (s1 at time zone 'Europe/Moscow')::date order by starts_at limit 1;
  insert into t values ('есть свободные слоты', s1 is not null and s2 is not null, s1::text || ' / ' || s2::text);

  -- 1. Запись от бота с telegram id.
  b1 := create_booking(svc, s1, 'Тест Бот', '+79991110001', m, null, 'bot', tg);
  insert into t values ('бот создаёт запись (source=bot)',
    (select source = 'bot' and client_telegram_id = tg from bookings where id = (b1->>'id')::uuid), b1::text);

  -- 2. Слот исчез из свободных и для сайта.
  insert into t values ('слот пропал из get_free_slots', not exists (select 1 from get_free_slots(svc, m, null, 14) where starts_at = s1), null);

  -- 3. Вторая запись на то же время отклоняется.
  begin perform create_booking(svc, s1, 'Второй', '+79991110002', m); r := 'created';
  exception when others then r := sqlerrm; end;
  insert into t values ('двойная запись отклонена', r in ('slot_unavailable', 'slot_taken'), r);

  -- 4. Перенос: на другой день проходит, слот s1 освобождается, s2 занимается.
  perform reschedule_booking((b1->>'id')::uuid, s2);
  insert into t values ('перенос сработал',
    exists (select 1 from get_free_slots(svc, m, null, 14) where starts_at = s1)
    and not exists (select 1 from get_free_slots(svc, m, null, 14) where starts_at = s2), null);

  -- 5. Перенос на занятое время отклоняется.
  b2 := create_booking(svc, s1, 'Другой клиент', '+79991110003', m);
  begin perform reschedule_booking((b1->>'id')::uuid, s1); r := 'moved';
  exception when others then r := sqlerrm; end;
  insert into t values ('перенос на занятое время отклонён', r in ('slot_unavailable', 'slot_taken'), r);

  -- 6. Отмена освобождает слот.
  update bookings set status = 'cancelled' where id = (b2->>'id')::uuid;
  insert into t values ('отмена освобождает слот', exists (select 1 from get_free_slots(svc, m, null, 14) where starts_at = s1), null);

  -- 7. Закрытое мастером время (time_blocks) убирает слоты.
  insert into time_blocks (master_id, starts_at, ends_at) values (m, s1, s1 + interval '1 hour');
  insert into t values ('закрытое время скрывает слот', not exists (select 1 from get_free_slots(svc, m, null, 14) where starts_at = s1), null);
  begin perform create_booking(svc, s1, 'Тест', '+79991110004', m, null, 'bot', tg + 1); r := 'created';
  exception when others then r := sqlerrm; end;
  insert into t values ('в закрытое время записаться нельзя', r = 'slot_unavailable', r);
  delete from time_blocks where master_id = m and starts_at = s1;

  -- 8. Заблокированный клиент (и по Telegram, и по телефону с сайта).
  insert into clients (telegram_id, phone, blocked) values (tg + 2, '+79991110005', true);
  begin perform create_booking(svc, s1, 'Блок', '+79991110099', m, null, 'bot', tg + 2); r := 'created';
  exception when others then r := sqlerrm; end;
  insert into t values ('блокировка по Telegram', r = 'client_blocked', r);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin perform create_booking(svc, s1, 'Блок', '+79991110005', m); r := 'created';
  exception when others then r := sqlerrm; end;
  insert into t values ('блокировка по телефону на сайте', r = 'client_blocked', r);

  -- 9. Лимит записей в сутки с одного аккаунта Telegram.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update settings set bot_daily_limit = 1;
  begin perform create_booking(svc, s1, 'Тест Бот', '+79991110006', m, null, 'bot', tg); r := 'created';
  exception when others then r := sqlerrm; end;
  insert into t values ('лимит в сутки на аккаунт', r = 'too_many_bookings', r);

  -- 10. anon не может выдать себя за бота или админа.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin perform create_booking(svc, s1, 'Хакер', '+79991110007', m, null, 'bot', 1); r := 'created';
  exception when others then r := sqlerrm; end;
  insert into t values ('anon не может source=bot', r = 'forbidden_source', r);
  begin perform create_booking(svc, s1, 'Хакер', '+79991110007', m, null, 'admin'); r := 'created';
  exception when others then r := sqlerrm; end;
  insert into t values ('anon не может source=admin', r = 'forbidden_source', r);

  -- 11. Напоминание уходит один раз: вторая вставка того же вида конфликтует.
  insert into reminders_sent (booking_id, kind) values ((b1->>'id')::uuid, '24h');
  begin insert into reminders_sent (booking_id, kind) values ((b1->>'id')::uuid, '24h'); r := 'inserted twice';
  exception when unique_violation then r := 'unique_violation'; end;
  insert into t values ('напоминание не дублируется', r = 'unique_violation', r);

  -- 12. Перенос сбрасывает отметки напоминаний (для нового времени они уйдут заново).
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform reschedule_booking((b1->>'id')::uuid, s1);
  insert into t values ('перенос сбрасывает напоминания', not exists (select 1 from reminders_sent where booking_id = (b1->>'id')::uuid), null);

  -- 13. Повторно доставленный update_id отклоняется.
  insert into processed_updates values (123456789);
  begin insert into processed_updates values (123456789); r := 'inserted twice';
  exception when unique_violation then r := 'unique_violation'; end;
  insert into t values ('update_id обрабатывается один раз', r = 'unique_violation', r);
end $$;

select name as "проверка", case when ok then 'ok' else 'FAIL' end as "результат", detail from t;
rollback;
