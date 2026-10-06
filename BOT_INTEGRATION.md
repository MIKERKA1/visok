# Telegram-бот: как он будет работать с этой базой

Бота пока нет. Схема уже готова к нему: бот пишет и читает те же таблицы, что сайт и админка, и создаёт записи той же функцией `create_booking`. Логика записи живёт в базе, у бота своей копии нет.

## Где бот запускается и каким ключом

Бот работает на сервере (VPS, Supabase Edge Function, любой Node/Python-хостинг) и ходит в Supabase с **service_role**-ключом. Этот ключ даёт полный доступ, поэтому он живёт только в переменных окружения сервера бота и никогда не попадает в браузер или в репозиторий.

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...   # Supabase → Project Settings → API keys
TELEGRAM_BOT_TOKEN=...
```

## Какие таблицы и функции нужны боту

| Что | Где | Зачем боту |
|---|---|---|
| Услуги | `services` (`is_active = true`, порядок `sort_order`) | Кнопки выбора услуги с ценой и длительностью |
| Мастера | `masters` (`is_active = true`) | Выбор мастера; `telegram_chat_id` для уведомлений мастеру |
| Кто что делает | `master_services` | Показать только мастеров, которые делают выбранную услугу |
| Свободное время | RPC `get_free_slots(p_service_id, p_master_id, p_from, p_days)` | Список слотов. `p_master_id = null` значит «любой свободный». График, выходные, длительность и занятые записи учитываются в базе |
| Создание записи | RPC `create_booking(...)` с `p_source = 'bot'` и `p_client_telegram_id` | Та же функция, что у сайта: проверка телефона, лимит записей на номер, проверка слота. Двойную запись запрещает exclusion constraint |
| Записи клиента | `bookings` где `client_telegram_id = <id>` | «Мои записи», отмена |
| Часовой пояс | `settings.timezone` | Показывать время клиенту по местному времени заведения. В базе всё хранится в UTC |

`source = 'bot'` функция принимает только от service_role. С сайта (anon) такой источник не пройдёт, ответ будет `forbidden_source`.

### Пример создания записи (Node, supabase-js)

```js
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data, error } = await sb.rpc('create_booking', {
  p_service_id: serviceId,
  p_master_id: masterId,            // или null: база выберет свободного мастера
  p_starts_at: slot.starts_at,      // ровно то значение, что вернул get_free_slots
  p_client_name: name,
  p_client_phone: phone,            // удобнее всего просить кнопкой «Поделиться контактом»
  p_comment: comment ?? null,
  p_source: 'bot',
  p_client_telegram_id: ctx.from.id,
});
// В error.message приходит код: slot_taken, slot_unavailable, too_many_bookings, invalid_phone, invalid_name, time_in_past
```

Коды ошибок те же, что обрабатывает сайт (`src/booking.js`): тексты для пользователя можно взять оттуда.

## Как бот узнаёт о новых записях

Новые записи приходят с сайта, из админки и от самого бота. Мастеру нужно уведомление о каждой. Есть два способа, выбрать один:

1. **Database Webhook (рекомендую).** Supabase → Database → Webhooks → новая точка: таблица `bookings`, событие `INSERT` (и `UPDATE`, если нужно сообщать об отменах), метод POST на адрес бота, например `https://bot.example.com/hooks/booking`. В заголовок добавьте секрет и проверяйте его на стороне бота. Постоянное соединение не нужно, бот может спать между запросами.
2. **Realtime.** Таблица `bookings` уже добавлена в публикацию `supabase_realtime` (так работает живое обновление в админке). Бот с service_role подписывается:

```js
sb.channel('bookings-bot')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bookings' }, ({ new: b }) => notifyMaster(b))
  .subscribe();
```

Realtime требует, чтобы процесс бота работал постоянно.

В обработчике: взять `masters.telegram_chat_id` по `b.master_id` и отправить мастеру сообщение с временем (переведённым в `settings.timezone`), услугой, именем и телефоном клиента.

## Где хранится telegram_chat_id

- **Мастер:** `masters.telegram_chat_id`. Мастер пишет боту `/start`, бот отвечает его chat id, админ вписывает число в карточку мастера (Админка → Мастера → Изменить → «Telegram chat id»). Позже это можно автоматизировать одноразовым кодом.
- **Клиент:** `bookings.client_telegram_id` у каждой записи из бота. По нему бот показывает клиенту его записи и шлёт напоминания.

## Отмена и напоминания

- **Отмена:** `update bookings set status = 'cancelled' where id = :id and client_telegram_id = :tg`. Отменённые записи не занимают время (exclusion constraint их не учитывает), слот сразу появляется в `get_free_slots` и на сайте.
- **Напоминание за 2–3 часа:** раз в 10–15 минут выбирать записи со `status in ('new', 'confirmed')` и `starts_at` в нужном окне, отправлять клиенту и отмечать отправку. Для отметки понадобится колонка, например `reminded_at timestamptz`, её добавят вместе с ботом.

## Чего в боте делать не надо

- Не считать свободные слоты в коде бота: их уже считает `get_free_slots`.
- Не вставлять строки в `bookings` напрямую: проверки живут в `create_booking`, а прямой insert их обходит.
- Не хранить service_role-ключ в клиентском коде или в репозитории.
