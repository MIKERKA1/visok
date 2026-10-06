// deno test supabase/functions/bot/logic.test.ts
import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  addDays, canCancel, canMarkVisit, checkInitData, dayKey, decodeSlot, encodeSlot, fitsCallback, groupSlots,
  normalizePhone, ownsBooking, reminderKind, reviewDue, summarize, workMinutes, zonedToUtc,
} from './logic.ts';

const TZ = 'Europe/Moscow';
const H = 3_600_000;
const at = (iso: string) => new Date(iso);

Deno.test('отмена: можно ровно за N часов и раньше, позже нельзя', () => {
  const now = at('2026-10-10T09:00:00Z');
  assert(canCancel('2026-10-10T12:00:00Z', now, 3));
  assert(canCancel('2026-10-11T12:00:00Z', now, 3));
  assert(!canCancel('2026-10-10T11:59:00Z', now, 3));
  assert(!canCancel('2026-10-10T08:00:00Z', now, 3));
});

Deno.test('напоминания: 24 ч и 2 ч, и пропуск, если записались внутри окна', () => {
  const start = '2026-10-10T15:00:00Z';
  const early = '2026-10-05T10:00:00Z';
  assertEquals(reminderKind({ starts_at: start, created_at: early }, new Date(Date.parse(start) - 30 * H)), null);
  assertEquals(reminderKind({ starts_at: start, created_at: early }, new Date(Date.parse(start) - 23.9 * H)), '24h');
  assertEquals(reminderKind({ starts_at: start, created_at: early }, new Date(Date.parse(start) - 1.9 * H)), '2h');
  assertEquals(reminderKind({ starts_at: start, created_at: early }, new Date(Date.parse(start) + H)), null);
  // Записался за 10 часов: 24-часового нет, 2-часовое будет.
  const late = new Date(Date.parse(start) - 10 * H).toISOString();
  assertEquals(reminderKind({ starts_at: start, created_at: late }, new Date(Date.parse(start) - 9 * H)), null);
  assertEquals(reminderKind({ starts_at: start, created_at: late }, new Date(Date.parse(start) - 1.5 * H)), '2h');
  // Записался за час: напоминаний нет.
  const veryLate = new Date(Date.parse(start) - H).toISOString();
  assertEquals(reminderKind({ starts_at: start, created_at: veryLate }, new Date(Date.parse(start) - 0.5 * H)), null);
});

Deno.test('отзыв: через 2 часа после визита и не позже двух суток', () => {
  const end = '2026-10-10T15:00:00Z';
  assert(!reviewDue(end, new Date(Date.parse(end) + 1 * H), 2));
  assert(reviewDue(end, new Date(Date.parse(end) + 2 * H), 2));
  assert(!reviewDue(end, new Date(Date.parse(end) + 49 * H), 2));
});

Deno.test('телефон нормализуется как в create_booking', () => {
  assertEquals(normalizePhone('8 (999) 123-45-67'), '+79991234567');
  assertEquals(normalizePhone('9991234567'), '+79991234567');
  assertEquals(normalizePhone('+7 999 123 45 67'), '+79991234567');
  assertEquals(normalizePhone('12345'), null);
});

Deno.test('роли: запись видит владелец, отметки ставит её мастер или админ', () => {
  const b = { client_telegram_id: 111, client_phone: '+79990000001', master_id: 'm1' };
  assert(ownsBooking(b, 111, null));
  assert(ownsBooking(b, 222, '+79990000001'));
  assert(!ownsBooking(b, 222, '+79990000002'));
  assert(!ownsBooking({ ...b, client_telegram_id: null }, 222, null));
  assert(canMarkVisit('master', 'm1', b));
  assert(!canMarkVisit('master', 'm2', b));
  assert(!canMarkVisit('client', 'm1', b));
  assert(canMarkVisit('admin', null, b));
});

Deno.test('слоты группируются по дням в часовом поясе заведения, без повторов', () => {
  const slots = [
    { master_id: 'a', starts_at: '2026-10-10T20:30:00Z' }, // 23:30 по Москве, 10-е
    { master_id: 'b', starts_at: '2026-10-10T21:00:00Z' }, // 00:00 по Москве, уже 11-е
    { master_id: 'a', starts_at: '2026-10-10T07:00:00Z' },
    { master_id: 'b', starts_at: '2026-10-10T07:00:00+00:00' }, // то же время у другого мастера
  ];
  const g = groupSlots(slots, TZ);
  assertEquals([...g.keys()], ['2026-10-10', '2026-10-11']);
  assertEquals(g.get('2026-10-10')!.length, 2);
});

Deno.test('время: местное ↔ UTC и ключ дня', () => {
  assertEquals(zonedToUtc('2026-10-10', '10:00', TZ), '2026-10-10T07:00:00.000Z');
  assertEquals(dayKey('2026-10-10T21:30:00Z', TZ), '2026-10-11');
  assertEquals(addDays('2026-12-31', 1), '2027-01-01');
});

Deno.test('callback_data укладывается в 64 байта', () => {
  const iso = '2026-10-10T07:15:00.000Z';
  assertEquals(decodeSlot(encodeSlot(iso)), iso);
  assert(fitsCallback(`b:t:${encodeSlot(iso)}`));
  assert(fitsCallback(`x:00000000-0000-0000-0000-000000000000`));
  assert(fitsCallback(`ms:done:00000000-0000-0000-0000-000000000000`));
  assert(!fitsCallback('x'.repeat(65)));
});

Deno.test('initData: верная подпись проходит, поддельная и старая нет', async () => {
  const token = '123456:TEST-token';
  const user = JSON.stringify({ id: 42, first_name: 'Иван' });
  const authDate = Math.floor(Date.now() / 1000);
  const fields: Record<string, string> = { auth_date: String(authDate), query_id: 'AAA', user };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const key = async (raw: Uint8Array) => crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const secret = new Uint8Array(await crypto.subtle.sign('HMAC', await key(enc.encode('WebAppData')), enc.encode(token)));
  const hash = [...new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(check)))]
    .map((x) => x.toString(16).padStart(2, '0')).join('');
  const initData = new URLSearchParams({ ...fields, hash }).toString();

  assertEquals((await checkInitData(initData, token))?.id, 42);
  assertEquals(await checkInitData(initData, '123456:OTHER'), null);
  assertEquals(await checkInitData(initData.replace('%22id%22%3A42', '%22id%22%3A43'), token), null);
  assertEquals(await checkInitData(initData, token, 60, (authDate + 3600) * 1000), null);
});

Deno.test('статистика: отмены, no-show, выручка по прайсу, загрузка', () => {
  const b = (status: string, svc = 's1', m = 'm1') => ({ master_id: m, service_id: svc, status, starts_at: '2026-10-10T10:00:00Z', ends_at: '2026-10-10T11:00:00Z' });
  const s = summarize({
    bookings: [b('done'), b('done', 's2'), b('cancelled'), b('no_show'), b('new', 's1', 'm2')],
    prices: { s1: 2000, s2: 1500 },
    workMinutesByMaster: { m1: 600, m2: 600 },
  });
  assertEquals(s.total, 5);
  assertEquals(s.cancelled, 1);
  assertEquals(s.noShow, 1);
  assertEquals(s.revenue, 2000 + 1500 + 2000);
  assertEquals(s.load, { m1: 20, m2: 10 });
});

Deno.test('рабочие минуты по графику без выходных', () => {
  // 2026-10-12 понедельник. График пн 10–14 и 15–20, вт 11–21.
  const hours = [
    { weekday: 1, start_time: '10:00:00', end_time: '14:00:00' },
    { weekday: 1, start_time: '15:00:00', end_time: '20:00:00' },
    { weekday: 2, start_time: '11:00:00', end_time: '21:00:00' },
  ];
  assertEquals(workMinutes(hours, new Set(), '2026-10-12', 2), 9 * 60 + 10 * 60);
  assertEquals(workMinutes(hours, new Set(['2026-10-13']), '2026-10-12', 2), 9 * 60);
});
