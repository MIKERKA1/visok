// Edge Function «bot». Пути:
//   POST /bot/webhook        апдейты Telegram (проверка X-Telegram-Bot-Api-Secret-Token)
//   POST /bot/notify         триггер на bookings: новая запись, отмена, перенос (заголовок x-internal-secret)
//   POST /bot/cron           pg_cron раз в 5 минут: напоминания и просьбы об отзыве
//   POST /bot/setup          один раз после деплоя: вебхук, команды, кнопка Mini App, описание
//   POST /bot/miniapp/me     Mini App: известные имя и телефон клиента (проверка initData)
//   POST /bot/miniapp/book   Mini App: запись через ту же create_booking
import { InlineKeyboard, webhookCallback } from 'npm:grammy@1.46.0';
import site from './site-config.js';
import { COMMANDS, DESCRIPTION, SHORT_DESCRIPTION, T } from './texts.ts';
import { adminIds, db, getRef, getSecrets, must, saveClient, type Row } from './db.ts';
import { createBot, miniAppUrl, when, type VisokBot } from './bot.ts';
import { canCancel, checkInitData, normalizePhone, reminderKind, reviewDue } from './logic.ts';

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const FN_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/bot`;
const ALLOWED_ORIGINS = [new URL(site.siteUrl).origin, 'http://localhost:5174'];

let bot: VisokBot | null = null;
let handle: ((req: Request) => Promise<Response>) | null = null;
const getBot = () => (bot ||= createBot(TOKEN));

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function cors(req: Request): HeadersInit {
  const origin = req.headers.get('origin') ?? '';
  return ALLOWED_ORIGINS.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', Vary: 'Origin' }
    : {};
}

// Сравнение секретов без утечки по времени.
function same(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^\/bot/, '') || '/';
  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== 'POST') return new Response('ok');
    if (!TOKEN) return json({ error: 'TELEGRAM_BOT_TOKEN is not set' }, 503);
    const secrets = await getSecrets();

    if (path === '/webhook') {
      handle ||= webhookCallback(getBot(), 'std/http', { secretToken: secrets.bot_webhook_secret, timeoutMilliseconds: 50_000, onTimeout: 'return' });
      return await handle(req);
    }
    if (path.startsWith('/miniapp/')) return await miniapp(req, path);

    if (!same(req.headers.get('x-internal-secret') ?? '', secrets.bot_internal_secret)) return json({ error: 'forbidden' }, 403);
    const body = await req.json().catch(() => ({}));
    if (path === '/notify') return json(await notify(body));
    if (path === '/cron') return json(await cron());
    if (path === '/setup') return json(await setup(secrets.bot_webhook_secret));
    return json({ error: 'not found' }, 404);
  } catch (e) {
    console.error(path, e);
    return json({ error: 'internal' }, 500);
  }
});

// ─── Уведомления мастеру и админам о записях с любого источника ───
async function notify({ op, record: b, old }: { op: string; record: Row; old: Row | null }) {
  const { services, masters } = await getRef();
  const service = services.find((s) => s.id === b.service_id)?.name ?? '';
  const masterRow = masters.find((m) => m.id === b.master_id);
  const master = masterRow?.name ?? '';
  let text: string | null = null;
  if (op === 'INSERT') text = T.nNew(await when(b.starts_at), b.client_name, b.client_phone, service, master, T.source[b.source] ?? b.source);
  else if (old && b.status === 'cancelled' && old.status !== 'cancelled') text = T.nCancel(await when(b.starts_at), b.client_name, service, master);
  else if (old && new Date(b.starts_at).getTime() !== new Date(old.starts_at).getTime()) {
    text = T.nMove(await when(old.starts_at), await when(b.starts_at), b.client_name, master);
  }
  if (!text) return { skipped: true };
  const ids = [...new Set([masterRow?.telegram_chat_id, ...(await adminIds())].filter(Boolean).map(Number))];
  return await getBot().broadcastTo(ids, text);
}

// ─── Напоминания и просьбы об отзыве. Каждое уходит один раз: сначала занимаем строку в reminders_sent. ───
async function claim(bookingId: string, kind: string) {
  const { error } = await db.from('reminders_sent').insert({ booking_id: bookingId, kind });
  if (error && error.code !== '23505') throw new Error(error.message);
  return !error;
}

async function cron() {
  const now = new Date();
  const { services, masters } = await getRef();
  const day = 86_400_000;
  const [upcoming, finished] = await Promise.all([
    must(db.from('bookings').select('*').in('status', ['new', 'confirmed'])
      .gt('starts_at', now.toISOString()).lte('starts_at', new Date(now.getTime() + day).toISOString())),
    must(db.from('bookings').select('*').eq('status', 'done')
      .gte('ends_at', new Date(now.getTime() - 2 * day).toISOString()).lte('ends_at', now.toISOString())),
  ]);
  const all: Row[] = [...upcoming, ...finished];
  // Кому писать: аккаунт из записи или клиент с тем же телефоном (запись с сайта).
  const phones = [...new Set(all.map((b) => b.client_phone))];
  const tgIds = [...new Set(all.map((b) => b.client_telegram_id).filter(Boolean))];
  const [byPhone, byTgRows] = await Promise.all([
    phones.length ? must(db.from('clients').select('*').in('phone', phones)) : Promise.resolve([] as Row[]),
    tgIds.length ? must(db.from('clients').select('*').in('telegram_id', tgIds)) : Promise.resolve([] as Row[]),
  ]);
  const byTg = new Map<number, Row>(byTgRows.map((c: Row) => [Number(c.telegram_id), c]));
  const recipient = (b: Row) => {
    const c = b.client_telegram_id ? byTg.get(Number(b.client_telegram_id)) : byPhone.find((x: Row) => x.phone === b.client_phone && x.telegram_id);
    const id = b.client_telegram_id ?? c?.telegram_id;
    return id && c?.notifications_enabled !== false && !c?.blocked ? Number(id) : null;
  };
  const api = getBot().api;
  let sent = 0;

  for (const b of upcoming) {
    const kind = reminderKind(b, now);
    const to = recipient(b);
    if (!kind || !to || !(await claim(b.id, kind))) continue;
    const service = services.find((s) => s.id === b.service_id)?.name ?? '';
    const master = masters.find((m) => m.id === b.master_id)?.name ?? '';
    const w = await when(b.starts_at);
    const allowCancel = canCancel(b.starts_at, now, site.bot.cancelMinHours);
    const kb = new InlineKeyboard().text(T.btn.willCome, `rc:${b.id}`);
    if (allowCancel) kb.text(T.btn.cancelBooking, `x:${b.id}`);
    let text = kind === '24h' ? T.remind24(w, service, master) : T.remind2(w, service, master);
    if (!allowCancel) text += `\n\n${T.remindCallToCancel(site.phone)}`;
    await api.sendMessage(to, text, { parse_mode: 'HTML', reply_markup: kb }).then(() => sent++).catch((e) => console.error('remind', e.message));
  }

  for (const b of finished) {
    const to = recipient(b);
    if (!to || !reviewDue(b.ends_at, now, site.bot.reviewDelayHours) || !(await claim(b.id, 'review'))) continue;
    const master = masters.find((m) => m.id === b.master_id)?.name ?? '';
    const kb = new InlineKeyboard();
    for (let n = 1; n <= 5; n++) kb.text(String(n), `rv:${n}:${b.id}`);
    await api.sendMessage(to, T.askReview(master), { parse_mode: 'HTML', reply_markup: kb }).then(() => sent++).catch((e) => console.error('review', e.message));
  }
  return { sent };
}

// ─── Первичная настройка после деплоя: вызывается из базы через bot_call('setup') ───
async function setup(secretToken: string) {
  const api = getBot().api;
  const me = await api.getMe();
  await api.setWebhook(`${FN_URL}/webhook`, { secret_token: secretToken, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  await api.setMyCommands(COMMANDS);
  await api.setMyDescription(DESCRIPTION(site.name, site.address.city));
  await api.setMyShortDescription(SHORT_DESCRIPTION(site.name));
  await api.setChatMenuButton({ menu_button: { type: 'web_app', text: T.btn.book, web_app: { url: miniAppUrl() } } });
  await must(db.from('settings').update({ bot_username: me.username }).eq('id', true));
  return { ok: true, username: me.username, webhook: `${FN_URL}/webhook` };
}

// ─── Mini App: страница записи сайта внутри Telegram ───
async function miniapp(req: Request, path: string) {
  const headers = cors(req);
  const body = await req.json().catch(() => ({}));
  const user = await checkInitData(String(body.initData ?? ''), TOKEN);
  if (!user) return json({ error: 'bad_init_data' }, 401, headers);
  const client = await must(db.from('clients').select('*').eq('telegram_id', user.id).maybeSingle());

  if (path === '/miniapp/me') return json({ name: client?.name ?? user.first_name ?? '', phone: client?.phone ?? '' }, 200, headers);

  if (path === '/miniapp/book') {
    const phone = normalizePhone(String(body.phone ?? ''));
    if (!phone) return json({ error: 'invalid_phone' }, 400, headers);
    const name = String(body.name ?? '').trim().slice(0, 80);
    await saveClient(user.id, { name: name || client?.name || user.first_name || null, phone });
    const { data, error } = await db.rpc('create_booking', {
      p_service_id: body.serviceId,
      p_master_id: body.masterId ?? null,
      p_starts_at: body.startsAt,
      p_client_name: name,
      p_client_phone: phone,
      p_comment: body.comment ? String(body.comment).slice(0, 500) : null,
      p_source: 'bot',
      p_client_telegram_id: user.id,
    });
    if (error) return json({ error: error.message }, 400, headers);
    return json(data, 200, headers);
  }
  return json({ error: 'not found' }, 404, headers);
}
