// Чистые функции бота: без сети и базы, поэтому покрыты тестами (logic.test.ts).

export type Role = 'client' | 'master' | 'admin';
export interface Slot { master_id: string; starts_at: string }
export interface BookingLike {
  id: string;
  master_id: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
  status: string;
  client_telegram_id: number | null;
  client_phone: string;
}

const HOUR = 3_600_000;

// ─── Время в часовом поясе заведения ───
export const dayKey = (iso: string | Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

export const fmtTime = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

export const fmtDate = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(iso));

// «пн, 7 окт» для кнопки дня; key — YYYY-MM-DD.
export function dayLabel(key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(d).replace('.', '');
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Местное время заведения → UTC ISO.
export function zonedToUtc(key: string, time: string, tz: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - guess;
  return new Date(guess - offset).toISOString();
}

// Слоты по дням, без повторов времени (у «любого мастера» одно время бывает у нескольких).
export function groupSlots(slots: Slot[], tz: string): Map<string, string[]> {
  const byDay = new Map<string, Set<string>>();
  for (const s of slots) {
    const k = dayKey(s.starts_at, tz);
    if (!byDay.has(k)) byDay.set(k, new Set());
    byDay.get(k)!.add(new Date(s.starts_at).toISOString());
  }
  return new Map([...byDay].map(([k, set]) => [k, [...set].sort()]));
}

// ─── Короткая упаковка времени для callback_data (лимит Telegram 64 байта) ───
export const encodeSlot = (iso: string) => Math.round(new Date(iso).getTime() / 60_000).toString(36);
export const decodeSlot = (s: string) => new Date(parseInt(s, 36) * 60_000).toISOString();

export function fitsCallback(data: string): boolean {
  return new TextEncoder().encode(data).length <= 64;
}

// ─── Правила ───
export function canCancel(startsAt: string, now: Date, minHours: number): boolean {
  return new Date(startsAt).getTime() - now.getTime() >= minHours * HOUR;
}

// Какое напоминание пора отправить. Если клиент записался уже внутри окна, это напоминание пропускаем.
export function reminderKind(b: Pick<BookingLike, 'starts_at' | 'created_at'>, now: Date): '24h' | '2h' | null {
  const left = new Date(b.starts_at).getTime() - now.getTime();
  const lead = new Date(b.starts_at).getTime() - new Date(b.created_at).getTime();
  if (left <= 0) return null;
  if (left <= 2 * HOUR) return lead > 2 * HOUR ? '2h' : null;
  if (left <= 24 * HOUR) return lead > 23 * HOUR ? '24h' : null;
  return null;
}

// Пора ли просить оценку: визит закончился reviewDelayHours назад, но не раньше чем двое суток.
export function reviewDue(endsAt: string, now: Date, delayHours: number): boolean {
  const since = now.getTime() - new Date(endsAt).getTime();
  return since >= delayHours * HOUR && since <= 48 * HOUR;
}

// Повторяет нормализацию из create_booking, чтобы ловить ошибку до запроса.
export function normalizePhone(input: string): string | null {
  let d = (input || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10 && d[0] === '9') d = '7' + d;
  return d.length >= 11 && d.length <= 15 ? '+' + d : null;
}

// Принадлежит ли запись клиенту: по аккаунту Telegram или по телефону (запись могла прийти с сайта).
export function ownsBooking(b: Pick<BookingLike, 'client_telegram_id' | 'client_phone'>, tgId: number, phone: string | null): boolean {
  return b.client_telegram_id === tgId || (!!phone && b.client_phone === phone);
}

// Отмечать «пришёл / не пришёл» может мастер этой записи или админ.
export function canMarkVisit(role: Role, userMasterId: string | null, b: Pick<BookingLike, 'master_id'>): boolean {
  return role === 'admin' || (role === 'master' && userMasterId === b.master_id);
}

// ─── Mini App: проверка подписи initData (core.telegram.org/bots/webapps) ───
async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export interface TgUser { id: number; first_name?: string; last_name?: string; username?: string }

export async function checkInitData(initData: string, botToken: string, maxAgeSec = 86_400, now = Date.now()): Promise<TgUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = await hmac('WebAppData', botToken);
  const expected = hex(await hmac(secret, check));
  if (expected.length !== hash.length) return null;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= expected.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff !== 0) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > maxAgeSec) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && typeof user.id === 'number' ? user : null;
  } catch {
    return null;
  }
}

// ─── Статистика для админа ───
export interface StatsInput {
  bookings: { master_id: string; service_id: string; status: string; starts_at: string; ends_at: string }[];
  prices: Record<string, number>;
  workMinutesByMaster: Record<string, number>;
}
export function summarize({ bookings, prices, workMinutesByMaster }: StatsInput) {
  const by = (s: string) => bookings.filter((b) => b.status === s).length;
  const live = bookings.filter((b) => b.status !== 'cancelled' && b.status !== 'no_show');
  const busy: Record<string, number> = {};
  for (const b of live) busy[b.master_id] = (busy[b.master_id] || 0) + (new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60_000;
  const load = Object.fromEntries(Object.entries(workMinutesByMaster)
    .map(([id, work]) => [id, work ? Math.round(((busy[id] || 0) / work) * 100) : 0]));
  return {
    total: bookings.length,
    cancelled: by('cancelled'),
    noShow: by('no_show'),
    done: by('done'),
    revenue: live.reduce((s, b) => s + (prices[b.service_id] || 0), 0),
    load,
  };
}

// Рабочие минуты мастера за период по графику, без выходных.
export function workMinutes(
  hours: { weekday: number; start_time: string; end_time: string }[],
  daysOff: Set<string>,
  from: string,
  days: number,
): number {
  const min = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  let total = 0;
  for (let i = 0; i < days; i++) {
    const key = addDays(from, i);
    if (daysOff.has(key)) continue;
    const wd = ((new Date(`${key}T12:00:00Z`).getUTCDay() + 6) % 7) + 1; // ISO: 1 = понедельник
    for (const h of hours) if (h.weekday === wd) total += min(h.end_time) - min(h.start_time);
  }
  return total;
}
