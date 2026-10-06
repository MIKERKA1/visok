// Обработчики бота. Запись идёт через те же RPC, что у сайта: get_free_slots, create_booking, reschedule_booking.
import { Bot, Context, InlineKeyboard, Keyboard, session } from 'npm:grammy@1.46.0';
import type { SessionFlavor, StorageAdapter } from 'npm:grammy@1.46.0';
import site from './site-config.js';
import { T, esc } from './texts.ts';
import { adminIds, db, getClient, getRef, must, saveClient, whoIs, type Row, type Who } from './db.ts';
import {
  addDays, canCancel, canMarkVisit, dayKey, dayLabel, decodeSlot, encodeSlot, fmtDate, fmtTime, groupSlots,
  normalizePhone, ownsBooking, summarize, workMinutes, zonedToUtc, type Role, type Slot,
} from './logic.ts';

// ─── Состояние диалога ───
type Step = 'service' | 'master' | 'day' | 'slot' | 'confirm';
interface Flow {
  mode: 'book' | 'move' | 'admin';
  step: Step;
  hist: Step[];
  serviceId?: string;
  masterId?: string | null;   // null = любой свободный
  masterLocked?: boolean;     // мастер выбран заранее (карточка мастера, перенос)
  day?: string;
  slot?: string;
  bookingId?: string;         // перенос
  name?: string;              // ручная запись админом
  phone?: string;
  notice?: string;
}
interface Session {
  flow?: Flow;
  await?: 'phone' | 'admin_name' | 'admin_phone' | 'broadcast' | 'block' | 'review';
  review?: { bookingId: string; rating: number };
  broadcast?: string;
}
type Ctx = Context & SessionFlavor<Session> & { who: Who; client: Row | null };

const cfg = site.bot;
const rub = new Intl.NumberFormat('ru-RU');
export const price = (n: number) => `${rub.format(n)} ₽`;
const dur = (m: number) => (m < 60 ? `${m} мин` : m % 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m / 60} ч`);
const plural = (n: number, f: [string, string, string]) =>
  f[n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 1 : 2];
const photoUrl = (u: string) => new URL(u, site.siteUrl).href;
export const miniAppUrl = () => `${site.siteUrl}?tgapp=1`;
const ACTIVE = ['new', 'confirmed'];

const storage: StorageAdapter<Session> = {
  read: async (key) => (await must(db.from('bot_sessions').select('value').eq('key', key).maybeSingle()))?.value,
  write: async (key, value) => { await must(db.from('bot_sessions').upsert({ key, value, updated_at: new Date().toISOString() })); },
  delete: async (key) => { await must(db.from('bot_sessions').delete().eq('key', key)); },
};

// Человекочитаемое время записи: «ср, 7 октября, 11:00».
export async function when(iso: string) {
  const { tz } = await getRef();
  return `${fmtDate(iso, tz)}, ${fmtTime(iso, tz)}`;
}

const roleOf = (w: Who): Role => (w.isAdmin ? 'admin' : w.masterId ? 'master' : 'client');

export function createBot(token: string) {
  const bot = new Bot<Ctx>(token);

  // Повторно доставленный update пропускаем: update_id уже в processed_updates.
  bot.use(async (ctx, next) => {
    const { error } = await db.from('processed_updates').insert({ update_id: ctx.update.update_id });
    if (error?.code === '23505') return;
    if (error) throw new Error(error.message);
    await next();
  });
  // Бот работает только в личке.
  bot.use(async (ctx, next) => { if (!ctx.chat || ctx.chat.type === 'private') await next(); });
  // После ответа на любую кнопку снимаем «часики» (если обработчик не ответил сам).
  bot.use(async (ctx, next) => { await next(); if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {}); });
  bot.use(session({ initial: (): Session => ({}), storage, getSessionKey: (ctx) => ctx.from?.id.toString() }));
  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    [ctx.who, ctx.client] = await Promise.all([whoIs(ctx.from.id), getClient(ctx.from.id)]);
    await next();
  });

  // ─── Вывод: на кнопку редактируем сообщение, иначе отправляем новое ───
  async function show(ctx: Ctx, text: string, kb?: InlineKeyboard) {
    const opts = { parse_mode: 'HTML' as const, reply_markup: kb, link_preview_options: { is_disabled: true } };
    if (ctx.callbackQuery?.message && 'text' in ctx.callbackQuery.message) {
      try { await ctx.editMessageText(text, opts); return; } catch (e) {
        if (String((e as Error).message).includes('message is not modified')) return;
      }
    }
    await ctx.reply(text, opts);
  }

  function menuKb(ctx: Ctx) {
    const kb = new InlineKeyboard()
      .text(T.btn.book, 'b:new').text(T.btn.my, 'my').row()
      .text(T.btn.services, 'svc').text(T.btn.masters, 'mst:0').row()
      .text(T.btn.address, 'addr').text(T.btn.contact, 'contact').row()
      .webApp(T.btn.miniApp, miniAppUrl()).row()
      .text(ctx.client?.notifications_enabled === false ? T.btn.remindersOff : T.btn.remindersOn, 'rem').row();
    if (ctx.who.masterId) kb.text(T.btn.today, 'md:0').text(T.btn.tomorrow, 'md:1').text(T.btn.closeTime, 'mc').row();
    if (ctx.who.isAdmin) {
      kb.text(T.btn.adminDay, 'ad:0').text(T.btn.adminBook, 'b:adm').row()
        .text(T.btn.stats, 'st:w').text(T.btn.broadcast, 'bc').text(T.btn.block, 'blk').row();
    }
    return kb;
  }
  const menuBack = () => new InlineKeyboard().text(T.btn.menu, 'menu');
  async function showMenu(ctx: Ctx, text = T.menu) { ctx.session.await = undefined; await show(ctx, text, menuKb(ctx)); }

  // ─── /start, меню, привязка мастера ───
  bot.command('start', async (ctx) => {
    ctx.session = {};
    const payload = ctx.match?.trim() ?? '';
    if (payload.startsWith('m_')) return linkMaster(ctx, payload.slice(2));
    if (!ctx.client) ctx.client = await saveClient(ctx.from!.id, { name: ctx.from!.first_name?.slice(0, 80) ?? null });
    await ctx.reply(T.start(ctx.from!.first_name ?? '', site.name), { parse_mode: 'HTML', reply_markup: menuKb(ctx) });
  });
  bot.command('id', (ctx) => ctx.reply(T.myId(ctx.from!.id), { parse_mode: 'HTML' }));
  bot.command('book', (ctx) => startFlow(ctx, 'book'));
  bot.command('my', (ctx) => myBookings(ctx));
  bot.command('today', (ctx) => masterDay(ctx, 0));
  bot.command('tomorrow', (ctx) => masterDay(ctx, 1));
  bot.command('admin', (ctx) => (ctx.who.isAdmin ? show(ctx, T.adminMenu, menuKb(ctx)) : ctx.reply(T.noAccess)));
  bot.callbackQuery('menu', (ctx) => showMenu(ctx));

  async function linkMaster(ctx: Ctx, code: string) {
    const row = await must(db.from('master_link_codes').select('*, masters(name)').eq('code', code.toUpperCase()).maybeSingle());
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) return ctx.reply(T.linkBad);
    await must(db.from('masters').update({ telegram_chat_id: null }).eq('telegram_chat_id', ctx.from!.id));
    await must(db.from('masters').update({ telegram_chat_id: ctx.from!.id }).eq('id', row.master_id));
    await must(db.from('master_link_codes').update({ used_at: new Date().toISOString() }).eq('code', row.code));
    ctx.who = await whoIs(ctx.from!.id);
    await ctx.reply(T.masterLinked(row.masters?.name ?? ''), { parse_mode: 'HTML', reply_markup: menuKb(ctx) });
  }

  // ─── Запись по шагам ───
  async function startFlow(ctx: Ctx, mode: Flow['mode'], preset: Partial<Flow> = {}) {
    if (mode === 'admin' && !ctx.who.isAdmin) return show(ctx, T.noAccess, menuBack());
    ctx.session.await = undefined;
    ctx.session.flow = { mode, step: 'service', hist: [], ...preset };
    await renderFlow(ctx);
  }

  async function go(ctx: Ctx, step: Step) {
    const f = ctx.session.flow!;
    f.hist.push(f.step);
    f.step = step;
    f.notice = undefined;
    await renderFlow(ctx);
  }

  // Слоты считает база, та же функция, что у сайта.
  // ponytail: при переносе не показываем время, пересекающееся с текущей записью; сдвиг «на 15 минут» даст grant на _free_slots.
  async function slotsFor(f: Flow, from: string, days: number): Promise<Slot[]> {
    return await must(db.rpc('get_free_slots', { p_service_id: f.serviceId, p_master_id: f.masterId ?? null, p_from: from, p_days: days }));
  }

  async function renderFlow(ctx: Ctx) {
    const f = ctx.session.flow;
    if (!f) return showMenu(ctx);
    const { services, masters, masterServices, tz } = await getRef();
    const svc = services.find((s) => s.id === f.serviceId);
    const masterName = masters.find((m) => m.id === f.masterId)?.name ?? T.anyMaster;
    const nav = (kb: InlineKeyboard) => (f.hist.length ? kb.text(T.btn.back, 'b:back') : kb).text(T.btn.cancel, 'b:x');
    const notice = f.notice ? `${esc(f.notice)}\n\n` : '';

    if (f.step === 'service') {
      const allowed = f.masterLocked
        ? new Set(masterServices.filter((x) => x.master_id === f.masterId).map((x) => x.service_id))
        : null;
      const kb = new InlineKeyboard();
      for (const s of services.filter((s) => !allowed || allowed.has(s.id))) kb.text(`${s.name}, ${price(s.price)}`, `b:s:${s.id}`).row();
      return show(ctx, notice + T.stepService, nav(kb));
    }
    if (f.step === 'master') {
      const ids = new Set(masterServices.filter((x) => x.service_id === f.serviceId).map((x) => x.master_id));
      const kb = new InlineKeyboard();
      if (f.mode !== 'admin') kb.text(T.btn.any, 'b:m:any').row();
      for (const m of masters.filter((m) => ids.has(m.id))) kb.text(m.name, `b:m:${m.id}`).row();
      return show(ctx, notice + T.stepMaster(svc?.name ?? ''), nav(kb));
    }
    if (f.step === 'day') {
      const byDay = groupSlots(await slotsFor(f, dayKey(new Date(), tz), 14), tz);
      const kb = new InlineKeyboard();
      let i = 0;
      for (const key of byDay.keys()) { kb.text(dayLabel(key), `b:d:${key}`); if (++i % 3 === 0) kb.row(); }
      if (i % 3) kb.row();
      const head = f.mode === 'move' && f.bookingId ? `${T.rescheduleDay(await bookingWhen(f.bookingId))}\n\n` : '';
      return show(ctx, notice + head + (byDay.size ? T.stepDay(svc?.name ?? '', masterName) : T.noDays), nav(kb));
    }
    if (f.step === 'slot') {
      const times = groupSlots(await slotsFor(f, f.day!, 1), tz).get(f.day!) ?? [];
      if (!times.length) { f.step = 'day'; f.notice = T.slotTaken; return renderFlow(ctx); }
      const kb = new InlineKeyboard();
      times.forEach((iso, i) => { kb.text(fmtTime(iso, tz), `b:t:${encodeSlot(iso)}`); if (i % 4 === 3) kb.row(); });
      if (times.length % 4) kb.row();
      return show(ctx, notice + T.stepSlot(svc?.name ?? '', masterName, dayLabel(f.day!)), nav(kb));
    }
    // confirm
    const kb = new InlineKeyboard().text(f.mode === 'move' ? T.btn.reschedule : T.btn.confirm, 'b:ok').row();
    const extra = f.mode === 'admin' ? `\nКлиент: ${esc(f.name)}, ${esc(f.phone)}` : '';
    return show(ctx, notice + T.confirm(svc?.name ?? '', price(svc?.price ?? 0), masterName, await when(f.slot!)) + extra, nav(kb));
  }

  async function bookingWhen(id: string) {
    const b = await must(db.from('bookings').select('starts_at').eq('id', id).single());
    return when(b.starts_at);
  }

  bot.callbackQuery('b:new', (ctx) => startFlow(ctx, 'book'));
  bot.callbackQuery('b:adm', (ctx) => startFlow(ctx, 'admin'));
  bot.callbackQuery(/^b:mst:(.+)$/, (ctx) => startFlow(ctx, 'book', { masterId: ctx.match[1], masterLocked: true }));

  // Остальные кнопки записи работают только внутри живого диалога: старая кнопка из истории чата ничего не ломает.
  bot.callbackQuery(/^b:(s|m|d|t|back|x|ok)(?::(.+))?$/, async (ctx) => {
    const f = ctx.session.flow;
    const [, kind, arg] = ctx.match;
    if (!f) return show(ctx, T.stale, menuBack());
    if (kind === 'x') { ctx.session.flow = undefined; ctx.session.await = undefined; return showMenu(ctx, T.cancelled); }
    if (kind === 'back') { f.step = f.hist.pop() ?? 'service'; f.notice = undefined; return renderFlow(ctx); }
    if (kind === 's') { f.serviceId = arg; f.slot = undefined; return go(ctx, f.masterLocked ? 'day' : 'master'); }
    if (kind === 'm') { f.masterId = arg === 'any' ? null : arg; return go(ctx, 'day'); }
    if (kind === 'd') { f.day = arg; return go(ctx, 'slot'); }
    if (kind === 't') {
      f.slot = decodeSlot(arg!);
      if (f.mode === 'admin' && !f.name) { ctx.session.await = 'admin_name'; return show(ctx, T.adminBookName); }
      if (f.mode === 'book' && !ctx.client?.phone) return askPhone(ctx);
      return go(ctx, 'confirm');
    }
    if (kind === 'ok') return submit(ctx);
  });

  async function askPhone(ctx: Ctx) {
    ctx.session.await = 'phone';
    // request_contact работает только на обычной клавиатуре, поэтому здесь отдельное сообщение.
    await ctx.reply(T.askPhone, { reply_markup: new Keyboard().requestContact(T.btn.sharePhone).resized().oneTime() });
  }

  async function submit(ctx: Ctx) {
    const f = ctx.session.flow!;
    const { tz } = await getRef();
    try {
      if (f.mode === 'move') {
        const b = await ownBooking(ctx, f.bookingId!);
        if (!b) return show(ctx, T.notYours, menuBack());
        if (!canCancel(b.starts_at, new Date(), cfg.cancelMinHours)) return show(ctx, T.cancelLate(cfg.cancelMinHours, site.phone), menuBack());
        await must(db.rpc('reschedule_booking', { p_booking_id: f.bookingId, p_new_starts_at: f.slot }));
        ctx.session.flow = undefined;
        return show(ctx, T.rescheduled(await when(f.slot!)), new InlineKeyboard().text(T.btn.my, 'my').text(T.btn.menu, 'menu'));
      }
      const name = (f.mode === 'admin' ? f.name ?? '' : ctx.client?.name || ctx.from!.first_name || '').trim();
      const res = await must(db.rpc('create_booking', {
        p_service_id: f.serviceId,
        p_master_id: f.masterId ?? null,
        p_starts_at: f.slot,
        p_client_name: name.length >= 2 ? name : 'Гость из Telegram',
        p_client_phone: f.mode === 'admin' ? f.phone : ctx.client?.phone,
        p_source: f.mode === 'admin' ? 'admin' : 'bot',
        p_client_telegram_id: f.mode === 'admin' ? null : ctx.from!.id,
      })) as Row;
      ctx.session.flow = undefined;
      const addr = `${site.address.street}, ${site.address.city}`;
      return show(ctx, T.booked(`${fmtDate(res.starts_at, tz)}, ${fmtTime(res.starts_at, tz)}`, res.master_name, addr),
        new InlineKeyboard().text(T.btn.my, 'my').text(T.btn.menu, 'menu'));
    } catch (e) {
      const code = (e as Error).message;
      if (['slot_taken', 'slot_unavailable', 'time_in_past'].includes(code)) {
        f.hist = f.hist.filter((s) => s !== 'confirm' && s !== 'slot');
        f.step = 'slot';
        f.notice = T.slotTaken;
        return renderFlow(ctx);
      }
      if (code === 'too_many_bookings') return show(ctx, T.tooMany, menuBack());
      if (code === 'client_blocked') return show(ctx, T.blocked, menuBack());
      if (code === 'invalid_phone') return askPhone(ctx);
      throw e;
    }
  }

  // ─── Текст и контакт: что ждём от человека ───
  bot.on('message:contact', async (ctx) => {
    if (ctx.session.await === 'phone') await acceptPhone(ctx, ctx.message.contact.phone_number);
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const s = ctx.session;
    if (s.await === 'phone') return acceptPhone(ctx, text);
    if (s.await === 'admin_name' && s.flow && ctx.who.isAdmin) {
      s.flow.name = text.slice(0, 80);
      s.await = 'admin_phone';
      return ctx.reply(T.adminBookPhone);
    }
    if (s.await === 'admin_phone' && s.flow && ctx.who.isAdmin) {
      const phone = normalizePhone(text);
      if (!phone) return ctx.reply(T.badPhone);
      s.flow.phone = phone;
      s.await = undefined;
      s.flow.hist.push(s.flow.step);
      s.flow.step = 'confirm';
      return renderFlow(ctx);
    }
    if (s.await === 'review' && s.review) return saveReview(ctx, text);
    if (s.await === 'broadcast' && ctx.who.isAdmin) return previewBroadcast(ctx, text);
    if (s.await === 'block' && ctx.who.isAdmin) return toggleBlock(ctx, text);
    return showMenu(ctx);
  });

  async function acceptPhone(ctx: Ctx, raw: string) {
    const phone = normalizePhone(raw);
    if (!phone) return ctx.reply(T.badPhone);
    ctx.client = await saveClient(ctx.from!.id, { phone, name: ctx.client?.name ?? ctx.from!.first_name?.slice(0, 80) ?? null });
    ctx.session.await = undefined;
    await ctx.reply(T.phoneSaved, { reply_markup: { remove_keyboard: true } });
    const f = ctx.session.flow;
    if (f?.slot) { f.hist.push(f.step); f.step = 'confirm'; await renderFlow(ctx); } else await showMenu(ctx);
  }

  // ─── Мои записи, отмена, перенос ───
  async function ownBooking(ctx: Ctx, id: string): Promise<Row | null> {
    const b = await must(db.from('bookings').select('*').eq('id', id).maybeSingle());
    return b && ownsBooking(b, ctx.from!.id, ctx.client?.phone ?? null) ? b : null;
  }

  async function myBookings(ctx: Ctx) {
    const { services, masters, tz } = await getRef();
    let q = db.from('bookings').select('*').in('status', ACTIVE).gt('starts_at', new Date().toISOString()).order('starts_at').limit(5);
    q = ctx.client?.phone
      ? q.or(`client_telegram_id.eq.${ctx.from!.id},client_phone.eq.${ctx.client.phone}`)
      : q.eq('client_telegram_id', ctx.from!.id);
    const list = await must(q);
    if (!list.length) return show(ctx, T.myEmpty, new InlineKeyboard().text(T.btn.book, 'b:new').text(T.btn.menu, 'menu'));
    const kb = new InlineKeyboard();
    const lines = list.map((b: Row) => {
      const label = `${dayLabel(dayKey(b.starts_at, tz))} ${fmtTime(b.starts_at, tz)}`;
      kb.text(`${T.btn.reschedule} ${label}`, `r:${b.id}`).text(T.btn.cancelBooking, `x:${b.id}`).row();
      return T.myItem(`${fmtDate(b.starts_at, tz)}, ${fmtTime(b.starts_at, tz)}`,
        services.find((s) => s.id === b.service_id)?.name ?? '', masters.find((m) => m.id === b.master_id)?.name ?? '');
    });
    kb.text(T.btn.menu, 'menu');
    await show(ctx, `${T.myTitle}\n\n${lines.join('\n\n')}`, kb);
  }
  bot.callbackQuery('my', (ctx) => myBookings(ctx));

  // Отмена и перенос: владелец и окно N часов проверяются на каждом нажатии.
  async function checkOwnActive(ctx: Ctx, id: string): Promise<Row | null> {
    const b = await ownBooking(ctx, id);
    if (!b || !ACTIVE.includes(b.status)) { await show(ctx, T.notYours, menuBack()); return null; }
    if (!canCancel(b.starts_at, new Date(), cfg.cancelMinHours)) { await show(ctx, T.cancelLate(cfg.cancelMinHours, site.phone), menuBack()); return null; }
    return b;
  }

  bot.callbackQuery(/^x:(.+)$/, async (ctx) => {
    const b = await checkOwnActive(ctx, ctx.match[1]);
    if (b) await show(ctx, T.askCancel(await when(b.starts_at)), new InlineKeyboard().text(T.btn.yesCancel, `xy:${b.id}`).text(T.btn.keep, 'my'));
  });

  bot.callbackQuery(/^xy:(.+)$/, async (ctx) => {
    const b = await checkOwnActive(ctx, ctx.match[1]);
    if (!b) return;
    await must(db.from('bookings').update({ status: 'cancelled' }).eq('id', b.id).in('status', ACTIVE));
    await show(ctx, T.cancelDone, new InlineKeyboard().text(T.btn.my, 'my').text(T.btn.menu, 'menu'));
  });

  bot.callbackQuery(/^r:(.+)$/, async (ctx) => {
    const b = await checkOwnActive(ctx, ctx.match[1]);
    if (b) await startFlow(ctx, 'move', { step: 'day', bookingId: b.id, serviceId: b.service_id, masterId: b.master_id, masterLocked: true });
  });

  // «Приду» из напоминания.
  bot.callbackQuery(/^rc:(.+)$/, async (ctx) => {
    const b = await ownBooking(ctx, ctx.match[1]);
    if (b) await must(db.from('bookings').update({ status: 'confirmed' }).eq('id', b.id).eq('status', 'new'));
    await ctx.answerCallbackQuery(T.willCome);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  // ─── Справка ───
  bot.callbackQuery('svc', async (ctx) => {
    const { services } = await getRef();
    await show(ctx, `${T.servicesTitle}\n\n${services.map((s) => T.serviceLine(s.name, price(s.price), dur(s.duration_min))).join('\n')}`,
      new InlineKeyboard().text(T.btn.book, 'b:new').text(T.btn.menu, 'menu'));
  });

  bot.callbackQuery(/^mst:(\d+)$/, async (ctx) => {
    const { masters } = await getRef();
    if (!masters.length) return show(ctx, T.myEmpty, menuBack());
    const i = Number(ctx.match[1]) % masters.length;
    const m = masters[i];
    const exp = m.experience_years != null ? `${m.experience_years} ${plural(m.experience_years, ['год', 'года', 'лет'])} в профессии` : '';
    const caption = T.masterCard(m.name, m.specialization ?? '', exp, m.bio ?? '');
    const kb = new InlineKeyboard()
      .text(T.btn.prev, `mst:${i - 1 + masters.length}`).text(`${i + 1} из ${masters.length}`, 'noop').text(T.btn.next, `mst:${i + 1}`).row()
      .text(T.btn.bookMaster, `b:mst:${m.id}`).row().text(T.btn.menu, 'menu');
    const msg = ctx.callbackQuery.message;
    try {
      if (m.photo_url && msg && 'photo' in msg) {
        await ctx.editMessageMedia({ type: 'photo', media: photoUrl(m.photo_url), caption, parse_mode: 'HTML' }, { reply_markup: kb });
      } else if (m.photo_url) {
        await ctx.replyWithPhoto(photoUrl(m.photo_url), { caption, parse_mode: 'HTML', reply_markup: kb });
      } else await show(ctx, caption, kb);
    } catch {
      await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: kb });
    }
  });
  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery('addr', async (ctx) => {
    await ctx.replyWithVenue(site.geo.lat, site.geo.lon, site.name, `${site.address.street}, ${site.address.city}`);
    const hours = site.hours.map((h: Row) => `${h.label} ${h.open}–${h.close}`).join(', ');
    await ctx.reply(T.addressText(site.address.street, site.address.city, site.address.note, hours, site.parking), { reply_markup: menuBack() });
  });

  bot.callbackQuery('contact', (ctx) => show(ctx, T.contactText(site.phone, cfg.adminContact),
    new InlineKeyboard().url(T.btn.contact, cfg.adminContact).row().text(T.btn.menu, 'menu')));

  bot.callbackQuery('rem', async (ctx) => {
    const on = ctx.client?.notifications_enabled === false;
    ctx.client = await saveClient(ctx.from.id, { notifications_enabled: on });
    await ctx.answerCallbackQuery(on ? T.remindersNowOn : T.remindersNowOff);
    await showMenu(ctx);
  });

  // ─── Отзыв после визита ───
  bot.callbackQuery(/^rv:(\d):(.+)$/, async (ctx) => {
    const b = await ownBooking(ctx, ctx.match[2]);
    if (!b) return show(ctx, T.notYours, menuBack());
    ctx.session.review = { bookingId: b.id, rating: Math.min(5, Math.max(1, Number(ctx.match[1]))) };
    ctx.session.await = 'review';
    await show(ctx, T.askReviewComment, new InlineKeyboard().text(T.btn.skip, 'rv:skip'));
  });
  bot.callbackQuery('rv:skip', (ctx) => (ctx.session.review ? saveReview(ctx, '') : show(ctx, T.stale, menuBack())));

  async function saveReview(ctx: Ctx, text: string) {
    const r = ctx.session.review!;
    ctx.session.review = undefined;
    ctx.session.await = undefined;
    const b = await must(db.from('bookings').select('master_id, client_name').eq('id', r.bookingId).single());
    const { masters } = await getRef();
    const author = ctx.client?.name || b.client_name || ctx.from!.first_name || 'Клиент';
    if (r.rating >= 4) {
      // Черновик: на сайте появится, когда админ включит «Показывать на сайте».
      await must(db.from('reviews').insert({
        author_name: author.slice(0, 60), text: (text || 'Без комментария').slice(0, 600), rating: r.rating,
        is_active: false, source: 'bot', booking_id: r.bookingId, sort_order: 100,
      }));
    } else {
      await broadcastTo(await adminIds(), T.nLowReview(r.rating, author, masters.find((m) => m.id === b.master_id)?.name ?? '', text));
    }
    await show(ctx, T.reviewThanks, menuBack());
  }

  // ─── Мастер: расписание, отметки, закрыть время ───
  async function masterDay(ctx: Ctx, offset: number, adminAll = false) {
    if (adminAll ? !ctx.who.isAdmin : !ctx.who.masterId) return show(ctx, T.noAccess, menuBack());
    const { services, masters, tz } = await getRef();
    const key = addDays(dayKey(new Date(), tz), offset);
    let q = db.from('bookings').select('*')
      .gte('starts_at', zonedToUtc(key, '00:00', tz)).lt('starts_at', zonedToUtc(addDays(key, 1), '00:00', tz))
      .neq('status', 'cancelled').order('starts_at');
    if (!adminAll) q = q.eq('master_id', ctx.who.masterId);
    const list = await must(q);
    const prefix = adminAll ? 'ad' : 'md';
    const kb = new InlineKeyboard();
    const lines = list.map((b: Row) => {
      const svc = services.find((s) => s.id === b.service_id)?.name ?? '';
      const line = adminAll ? `${svc}, ${masters.find((m) => m.id === b.master_id)?.name ?? ''}` : svc;
      // Кнопки отметок показываем, когда до визита меньше трёх часов или он уже прошёл.
      if (ACTIVE.includes(b.status) && new Date(b.starts_at).getTime() - Date.now() < 3 * 3_600_000) {
        kb.text(`${fmtTime(b.starts_at, tz)} ${T.btn.came}`, `ms:d:${b.id}:${offset}:${prefix}`)
          .text(T.btn.noShow, `ms:n:${b.id}:${offset}:${prefix}`).row();
      }
      return T.dayItem(fmtTime(b.starts_at, tz), b.client_name, b.client_phone, line, T.status[b.status] ?? '');
    });
    kb.text(T.btn.prev, `${prefix}:${offset - 1}`).text(T.btn.next, `${prefix}:${offset + 1}`).row().text(T.btn.menu, 'menu');
    const title = dayLabel(key);
    await show(ctx, list.length ? `${adminAll ? T.adminDayTitle(title, list.length) : T.dayTitle(title)}\n\n${lines.join('\n\n')}` : T.dayEmpty(title), kb);
  }
  bot.callbackQuery(/^md:(-?\d+)$/, (ctx) => masterDay(ctx, Number(ctx.match[1])));
  bot.callbackQuery(/^ad:(-?\d+)$/, (ctx) => masterDay(ctx, Number(ctx.match[1]), true));

  // Отметка визита: право проверяется по базе, а не по тому, что пришло в кнопке.
  bot.callbackQuery(/^ms:(d|n):([0-9a-f-]{36}):(-?\d+):(md|ad)$/, async (ctx) => {
    const b = await must(db.from('bookings').select('*').eq('id', ctx.match[2]).maybeSingle());
    if (!b || !canMarkVisit(roleOf(ctx.who), ctx.who.masterId, b)) return ctx.answerCallbackQuery(T.noAccess);
    const status = ctx.match[1] === 'd' ? 'done' : 'no_show';
    await must(db.from('bookings').update({ status }).eq('id', b.id));
    await ctx.answerCallbackQuery(T.marked(T.status[status]));
    await masterDay(ctx, Number(ctx.match[3]), ctx.match[4] === 'ad');
  });

  bot.callbackQuery('mc', (ctx) => (ctx.who.masterId
    ? show(ctx, T.closeMenu, new InlineKeyboard().text(T.closeHour, 'mc:h').row().text(T.closeRestOfDay, 'mc:r').row()
      .text(T.closeTomorrow, 'mc:t').row().text(T.btn.menu, 'menu'))
    : show(ctx, T.noAccess, menuBack())));

  bot.callbackQuery(/^mc:(h|r|t)$/, async (ctx) => {
    const masterId = ctx.who.masterId;
    if (!masterId) return show(ctx, T.noAccess, menuBack());
    const { tz } = await getRef();
    const today = dayKey(new Date(), tz);
    if (ctx.match[1] === 't') {
      const day = addDays(today, 1);
      await db.from('days_off').insert({ master_id: masterId, day, reason: 'Закрыто мастером в боте' }); // уже закрыт: не ошибка
      return show(ctx, T.closedDay(dayLabel(day)), menuBack());
    }
    const step = 15 * 60_000;
    const from = new Date(Math.ceil(Date.now() / step) * step);
    let to = new Date(from.getTime() + 3_600_000);
    if (ctx.match[1] === 'r') {
      const wd = ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      const hours = await must(db.from('working_hours').select('end_time').eq('master_id', masterId).eq('weekday', wd));
      const end = hours.map((h: Row) => String(h.end_time).slice(0, 5)).sort().pop();
      to = end ? new Date(zonedToUtc(today, end, tz)) : from;
    }
    if (to <= from) return show(ctx, T.closeNothing, menuBack());
    await must(db.from('time_blocks').insert({ master_id: masterId, starts_at: from.toISOString(), ends_at: to.toISOString(), reason: 'Закрыто мастером в боте' }));
    await show(ctx, T.closedBlock(fmtTime(from.toISOString(), tz), fmtTime(to.toISOString(), tz)), menuBack());
  });

  // ─── Админ: статистика, рассылка, блокировка ───
  bot.callbackQuery(/^st:(w|m)$/, async (ctx) => {
    if (!ctx.who.isAdmin) return show(ctx, T.noAccess, menuBack());
    const { services, masters, tz } = await getRef();
    const days = ctx.match[1] === 'w' ? 7 : 30;
    const today = dayKey(new Date(), tz);
    const fromKey = addDays(today, -(days - 1));
    const [bookings, hours, off] = await Promise.all([
      must(db.from('bookings').select('master_id, service_id, status, starts_at, ends_at')
        .gte('starts_at', zonedToUtc(fromKey, '00:00', tz)).lt('starts_at', zonedToUtc(addDays(today, 1), '00:00', tz))),
      must(db.from('working_hours').select('*')),
      must(db.from('days_off').select('*').gte('day', fromKey)),
    ]);
    const work = Object.fromEntries(masters.map((m) => [m.id, workMinutes(
      hours.filter((h: Row) => h.master_id === m.id),
      new Set(off.filter((o: Row) => !o.master_id || o.master_id === m.id).map((o: Row) => o.day)), fromKey, days)]));
    const s = summarize({ bookings, prices: Object.fromEntries(services.map((x) => [x.id, x.price])), workMinutesByMaster: work });
    const load = masters.map((m) => `${esc(m.name)}: ${s.load[m.id] ?? 0}%`).join('\n');
    await show(ctx, T.statsText(days === 7 ? 'неделю' : 'месяц', { ...s, revenue: price(s.revenue) }, load),
      new InlineKeyboard().text(T.btn.week, 'st:w').text(T.btn.month, 'st:m').row().text(T.btn.menu, 'menu'));
  });

  bot.callbackQuery('bc', async (ctx) => {
    if (!ctx.who.isAdmin) return show(ctx, T.noAccess, menuBack());
    ctx.session.await = 'broadcast';
    await show(ctx, T.broadcastAsk, new InlineKeyboard().text(T.btn.cancel, 'bc:x'));
  });
  bot.callbackQuery('bc:x', async (ctx) => { ctx.session.broadcast = undefined; await showMenu(ctx, T.broadcastCancelled); });

  const recipients = async () => (await must(db.from('clients').select('telegram_id')
    .eq('notifications_enabled', true).eq('blocked', false).not('telegram_id', 'is', null))).map((r: Row) => Number(r.telegram_id));

  async function previewBroadcast(ctx: Ctx, text: string) {
    ctx.session.await = undefined;
    ctx.session.broadcast = text.slice(0, 3500);
    await ctx.reply(ctx.session.broadcast);
    await ctx.reply(T.broadcastPreview((await recipients()).length),
      { reply_markup: new InlineKeyboard().text(T.btn.send, 'bc:go').text(T.btn.cancel, 'bc:x') });
  }

  bot.callbackQuery('bc:go', async (ctx) => {
    if (!ctx.who.isAdmin || !ctx.session.broadcast) return show(ctx, T.stale, menuBack());
    const text = ctx.session.broadcast;
    ctx.session.broadcast = undefined;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const { sent, failed } = await broadcastTo(await recipients(), text, false);
    await ctx.reply(T.broadcastDone(sent, failed), { reply_markup: menuBack() });
  });

  bot.callbackQuery('blk', async (ctx) => {
    if (!ctx.who.isAdmin) return show(ctx, T.noAccess, menuBack());
    ctx.session.await = 'block';
    await show(ctx, T.blockAsk, new InlineKeyboard().text(T.btn.cancel, 'menu'));
  });

  async function toggleBlock(ctx: Ctx, text: string) {
    ctx.session.await = undefined;
    const digits = text.replace(/\D/g, '');
    const looksPhone = /^\+|^8/.test(text.trim()) || (digits.length === 11 && digits[0] === '7');
    const phone = looksPhone ? normalizePhone(text) : null;
    const tgId = !looksPhone && /^\d{5,15}$/.test(digits) ? Number(digits) : null;
    if (!phone && !tgId) return ctx.reply(T.blockBad, { reply_markup: menuBack() });
    const existing = await must(phone
      ? db.from('clients').select('*').eq('phone', phone).limit(1).maybeSingle()
      : db.from('clients').select('*').eq('telegram_id', tgId).maybeSingle());
    const blocked = !existing?.blocked;
    if (existing) await must(db.from('clients').update({ blocked, updated_at: new Date().toISOString() }).eq('id', existing.id));
    else await must(db.from('clients').insert({ phone, telegram_id: tgId, blocked: true }));
    const who = phone ?? String(tgId);
    await ctx.reply(blocked ? T.blockDone(who) : T.unblockDone(who), { parse_mode: 'HTML', reply_markup: menuBack() });
  }

  // Telegram пускает не больше 30 сообщений в секунду: отправляем по одному с паузой 40 мс.
  // ponytail: всё в одном запросе, предел около 3500 получателей (150 с у Edge Function); больше — очередь в таблице и cron.
  async function broadcastTo(ids: number[], text: string, html = true) {
    let sent = 0, failed = 0;
    for (const id of ids) {
      const send = () => bot.api.sendMessage(id, text, html ? { parse_mode: 'HTML' } : {});
      try { await send(); sent++; } catch (e) {
        const retry = Number((e as { parameters?: { retry_after?: number } }).parameters?.retry_after);
        if (retry) {
          await new Promise((r) => setTimeout(r, retry * 1000));
          try { await send(); sent++; } catch { failed++; }
        } else failed++;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    return { sent, failed };
  }

  // Старые кнопки и непонятные нажатия: не молчим, предлагаем меню.
  bot.on('callback_query:data', (ctx) => show(ctx, T.stale, menuBack()));

  // Любая ошибка: человеку понятный ответ, админам короткий лог. Секреты в лог не попадают.
  bot.catch(async (err) => {
    const ctx = err.ctx;
    console.error('bot error', err.error);
    try { await ctx.reply(T.error); } catch { /* чат недоступен */ }
    const where = ctx.callbackQuery?.data ?? ctx.message?.text?.slice(0, 40) ?? String(ctx.update.update_id);
    const ids = await adminIds().catch(() => [] as number[]);
    await broadcastTo(ids, `Ошибка бота: ${esc(String((err.error as Error)?.message ?? err.error).slice(0, 300))}\nГде: ${esc(where)}`);
  });

  return Object.assign(bot, { broadcastTo });
}

export type VisokBot = ReturnType<typeof createBot>;
