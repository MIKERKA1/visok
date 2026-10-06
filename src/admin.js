import '@fontsource/oranienbaum';
import '@fontsource-variable/golos-text';
import './style.css';
import './admin.css';
import { createClient } from '@supabase/supabase-js';
import site from './config.js';
import { esc, price, duration } from './render.js';

const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
const app = document.getElementById('app');
const toasts = document.querySelector('.toasts');

const STATUS = { new: 'Новая', confirmed: 'Подтверждена', done: 'Пришёл', no_show: 'Не пришёл', cancelled: 'Отменена' };
const SOURCE = { site: 'сайт', bot: 'бот', admin: 'админка' };
const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const TABS = { bookings: 'Записи', services: 'Услуги', masters: 'Мастера', schedule: 'График', gallery: 'Галерея', reviews: 'Отзывы', bot: 'Бот' };

let tz = 'Europe/Moscow';
let botUsername = null;
let ref = { services: [], masters: [], masterServices: [] };
let shownFor = null;
let day = null;

// ─── Мелочи ───
function toast(msg, kind = 'ok') {
  const el = document.createElement('p');
  el.className = `toast toast--${kind}`;
  el.textContent = msg;
  toasts.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}
const fail = (error, what = 'Не сохранилось') => { console.error(error); toast(`${what}: ${error.message}`, 'error'); };

const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const timeOf = (d) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(d));
const shiftDay = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const longDay = (key) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${key}T12:00:00Z`));

// Местное время заведения → UTC.
function zonedToUtc(key, time) {
  const [y, m, d] = key.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess;
  return new Date(guess - offset).toISOString();
}

// Фото ужимаем в браузере до 1600 px и webp: с телефона прилетают файлы по 5–10 МБ.
async function uploadImage(file, folder) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.82));
  const path = `${folder}/${crypto.randomUUID()}.webp`;
  const { error } = await sb.storage.from('media').upload(path, blob, { contentType: 'image/webp' });
  if (error) throw error;
  return sb.storage.from('media').getPublicUrl(path).data.publicUrl;
}

async function loadRef() {
  const [s, m, ms, st] = await Promise.all([
    sb.from('services').select('*').order('sort_order'),
    sb.from('masters').select('*').order('sort_order'),
    sb.from('master_services').select('*'),
    sb.from('settings').select('timezone, bot_username').single(),
  ]);
  const err = s.error || m.error || ms.error;
  if (err) throw err;
  ref = { services: s.data, masters: m.data, masterServices: ms.data };
  tz = st.data?.timezone || tz;
  botUsername = st.data?.bot_username || null;
}
const masterName = (id) => ref.masters.find((m) => m.id === id)?.name || '—';
const serviceName = (id) => ref.services.find((s) => s.id === id)?.name || '—';

// ─── Вход ───
function renderLogin(message = '') {
  shownFor = null;
  sb.removeAllChannels();
  app.innerHTML = `
    <form class="login" id="login">
      <p class="login__brand">${esc(site.name)}</p>
      <h1 class="login__title">Вход для сотрудников</h1>
      <p class="muted">Пришлём ссылку для входа на почту. Пароль не нужен.</p>
      <div class="field">
        <label for="email">Почта</label>
        <input id="email" name="email" type="email" autocomplete="email" required>
      </div>
      <button class="btn btn--wide" type="submit">Прислать ссылку</button>
      <p class="login__msg" role="status">${esc(message)}</p>
      <p><a class="link" href="./">Вернуться на сайт</a></p>
    </form>`;
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const msg = e.target.querySelector('.login__msg');
    btn.disabled = true;
    const email = e.target.email.value.trim();
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0] } });
    btn.disabled = false;
    msg.textContent = error
      ? `Не получилось отправить: ${error.message}`
      : `Ссылка ушла на ${email}. Откройте письмо на этом устройстве.`;
  });
}

function renderDenied(email) {
  app.innerHTML = `<div class="login">
    <h1 class="login__title">Нет доступа</h1>
    <p>Почта ${esc(email)} не добавлена в список администраторов.</p>
    <button class="btn btn--ghost" type="button" id="out">Выйти</button></div>`;
  document.getElementById('out').onclick = () => sb.auth.signOut();
}

// ─── Каркас ───
async function renderShell(email) {
  shownFor = email;
  app.innerHTML = `
    <header class="adm-top">
      <p class="adm-top__brand">${esc(site.name)} <span class="muted">админка</span></p>
      <nav class="adm-tabs" aria-label="Разделы">${Object.entries(TABS).map(([k, v]) => `<a href="#${k}" data-tab="${k}">${v}</a>`).join('')}</nav>
      <div class="adm-top__me">
        <a class="link" href="./" target="_blank" rel="noopener">Сайт</a>
        <span class="muted">${esc(email)}</span>
        <button class="btn btn--small btn--ghost" type="button" id="logout">Выйти</button>
      </div>
    </header>
    <main class="adm-main" id="view" tabindex="-1"></main>
    <dialog class="sheet adm-dialog" id="edit" aria-labelledby="edit-title"></dialog>`;
  document.getElementById('logout').onclick = () => sb.auth.signOut();
  try { await loadRef(); } catch (e) { return fail(e, 'Не загрузились данные'); }
  day ||= dayKey(Date.now());
  route();
  // Новые записи с сайта и от бота появляются без перезагрузки.
  sb.channel('bookings').on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, (p) => {
    if (p.eventType === 'INSERT') toast(`Новая запись: ${p.new.client_name}, ${dayKey(p.new.starts_at) === day ? '' : p.new.starts_at.slice(0, 10) + ' '}${timeOf(p.new.starts_at)}`);
    if (currentTab() === 'bookings') renderBookings();
  }).subscribe();
}

const currentTab = () => (location.hash.slice(1) in TABS ? location.hash.slice(1) : 'bookings');
function route() {
  if (!shownFor) return;
  document.getElementById('edit')?.close();
  const tab = currentTab();
  document.querySelectorAll('[data-tab]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.tab === tab));
  ({ bookings: renderBookings, schedule: renderSchedule, bot: renderBot }[tab] || (() => renderEntity(tab)))();
}
addEventListener('hashchange', route);

// ─── Записи ───
async function renderBookings() {
  const view = document.getElementById('view');
  const from = new Date(`${shiftDay(day, -1)}T00:00:00Z`).toISOString();
  const to = new Date(`${shiftDay(day, 2)}T00:00:00Z`).toISOString();
  const { data, error } = await sb.from('bookings').select('*').gte('starts_at', from).lt('starts_at', to).order('starts_at');
  if (error) return fail(error, 'Не загрузились записи');
  const list = data.filter((b) => dayKey(b.starts_at) === day);
  const active = list.filter((b) => b.status !== 'cancelled');
  view.innerHTML = `
    <div class="adm-bar">
      <div class="adm-day">
        <button class="btn btn--small btn--ghost" type="button" data-day="-1" aria-label="Предыдущий день">←</button>
        <label class="visually-hidden" for="day">День</label>
        <input type="date" id="day" value="${day}">
        <button class="btn btn--small btn--ghost" type="button" data-day="1" aria-label="Следующий день">→</button>
        <button class="btn btn--small btn--ghost" type="button" data-day="0">Сегодня</button>
      </div>
      <button class="btn btn--small" type="button" id="add-booking">Добавить запись</button>
    </div>
    <h1 class="adm-h1">${esc(longDay(day))}</h1>
    <p class="muted">${active.length ? `${active.length} ${active.length === 1 ? 'запись' : active.length < 5 ? 'записи' : 'записей'}, выручка по прайсу ${price(active.reduce((s, b) => s + (ref.services.find((x) => x.id === b.service_id)?.price || 0), 0))}` : 'Записей нет.'}</p>
    <ul class="bookings" role="list">${list.map((b) => `
      <li class="booking booking--${b.status}">
        <p class="booking__time">${timeOf(b.starts_at)}<span class="muted">–${timeOf(b.ends_at)}</span></p>
        <div class="booking__main">
          <p class="booking__client"><strong>${esc(b.client_name)}</strong> <a class="link" href="tel:${esc(b.client_phone)}">${esc(b.client_phone)}</a></p>
          <p>${esc(serviceName(b.service_id))}, мастер ${esc(masterName(b.master_id))}</p>
          ${b.comment ? `<p class="booking__comment">«${esc(b.comment)}»</p>` : ''}
          <p class="muted booking__src">Источник: ${SOURCE[b.source]}${b.client_telegram_id ? `, Telegram ${b.client_telegram_id}` : ''}</p>
        </div>
        <label class="visually-hidden" for="st-${b.id}">Статус</label>
        <select id="st-${b.id}" data-status="${b.id}">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === b.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </li>`).join('')}
    </ul>`;
  view.querySelectorAll('[data-day]').forEach((btn) => btn.onclick = () => {
    const n = Number(btn.dataset.day);
    day = n ? shiftDay(day, n) : dayKey(Date.now());
    renderBookings();
  });
  view.querySelector('#day').onchange = (e) => { if (e.target.value) { day = e.target.value; renderBookings(); } };
  view.querySelectorAll('[data-status]').forEach((sel) => sel.onchange = async () => {
    const { error: e } = await sb.from('bookings').update({ status: sel.value }).eq('id', sel.dataset.status);
    if (e) return fail(e.message.includes('bookings_no_overlap') ? { message: 'на это время у мастера уже есть другая запись' } : e, 'Статус не изменён');
    toast(`Статус: ${STATUS[sel.value]}`);
    renderBookings();
  });
  view.querySelector('#add-booking').onclick = openBookingForm;
}

function openBookingForm() {
  const dlg = document.getElementById('edit');
  const active = ref.services.filter((s) => s.is_active);
  dlg.innerHTML = `
    <form class="adm-form" method="dialog">
      <h2 class="adm-h2" id="edit-title">Новая запись</h2>
      <div class="field"><label for="f-service">Услуга</label>
        <select id="f-service" name="service" required>${active.map((s) => `<option value="${s.id}">${esc(s.name)}, ${duration(s.duration_min)}</option>`).join('')}</select></div>
      <div class="field"><label for="f-master">Мастер</label><select id="f-master" name="master" required></select></div>
      <div class="adm-row">
        <div class="field"><label for="f-date">Дата</label><input id="f-date" name="date" type="date" value="${day}" required></div>
        <div class="field"><label for="f-time">Время</label><input id="f-time" name="time" type="time" step="300" required></div>
      </div>
      <div class="adm-free" aria-live="polite"></div>
      <div class="field"><label for="f-name">Имя клиента</label><input id="f-name" name="name" required minlength="2"></div>
      <div class="field"><label for="f-phone">Телефон</label><input id="f-phone" name="phone" type="tel" required></div>
      <div class="field"><label for="f-comment">Комментарий</label><textarea id="f-comment" name="comment" rows="2"></textarea></div>
      <div class="adm-actions">
        <button class="btn" type="submit">Сохранить</button>
        <button class="btn btn--ghost" type="button" data-cancel>Отмена</button>
      </div>
    </form>`;
  const f = dlg.querySelector('form');
  const fillMasters = () => {
    const ids = new Set(ref.masterServices.filter((x) => x.service_id === f.service.value).map((x) => x.master_id));
    f.master.innerHTML = ref.masters.filter((m) => m.is_active && ids.has(m.id)).map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  };
  // Подсказка: свободное время по графику. Админ может записать и вне его.
  const showFree = async () => {
    const box = dlg.querySelector('.adm-free');
    if (!f.master.value || !f.date.value) return (box.innerHTML = '');
    const { data } = await sb.rpc('get_free_slots', { p_service_id: f.service.value, p_master_id: f.master.value, p_from: f.date.value, p_days: 1 });
    box.innerHTML = data?.length
      ? `<p class="muted">Свободно по графику:</p><div class="slots">${data.map((s) => `<button class="slot" type="button" data-time="${timeOf(s.starts_at)}">${timeOf(s.starts_at)}</button>`).join('')}</div>`
      : '<p class="muted">По графику свободного времени нет, но можно записать вручную.</p>';
  };
  fillMasters(); showFree();
  f.service.onchange = () => { fillMasters(); showFree(); };
  f.master.onchange = showFree;
  f.date.onchange = showFree;
  dlg.querySelector('.adm-free').onclick = (e) => { const t = e.target.closest('[data-time]'); if (t) f.time.value = t.dataset.time; };
  dlg.querySelector('[data-cancel]').onclick = () => dlg.close();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.rpc('create_booking', {
      p_service_id: f.service.value,
      p_master_id: f.master.value,
      p_starts_at: zonedToUtc(f.date.value, f.time.value),
      p_client_name: f.name.value,
      p_client_phone: f.phone.value,
      p_comment: f.comment.value || null,
      p_source: 'admin',
    });
    if (error) {
      const msg = { slot_taken: 'у мастера на это время уже есть запись', invalid_phone: 'проверьте телефон', invalid_name: 'имя слишком короткое' }[error.message];
      return fail(msg ? { message: msg } : error, 'Запись не создана');
    }
    dlg.close();
    toast('Запись добавлена');
    day = f.date.value;
    renderBookings();
  };
  dlg.showModal();
}

// ─── Услуги, мастера, галерея, отзывы: общий редактор ───
const ENTITIES = {
  services: {
    table: 'services', one: 'услугу',
    fields: [
      { name: 'name', label: 'Название', required: true },
      { name: 'description', label: 'Описание', type: 'textarea' },
      { name: 'price', label: 'Цена, ₽', type: 'number', required: true },
      { name: 'duration_min', label: 'Длительность, мин', type: 'number', required: true, step: 5 },
      { name: 'sort_order', label: 'Порядок в списке', type: 'number' },
      { name: 'is_active', label: 'Показывать на сайте', type: 'checkbox' },
    ],
    row: (s) => `<strong>${esc(s.name)}</strong> <span class="muted">${price(s.price)}, ${duration(s.duration_min)}</span>`,
  },
  masters: {
    table: 'masters', one: 'мастера',
    fields: [
      { name: 'name', label: 'Имя и фамилия', required: true },
      { name: 'photo_url', label: 'Фото', type: 'image', folder: 'masters' },
      { name: 'specialization', label: 'Специализация' },
      { name: 'experience_years', label: 'Стаж, лет', type: 'number' },
      { name: 'bio', label: 'Пара слов о мастере', type: 'textarea' },
      { name: 'telegram_chat_id', label: 'Telegram chat id (для уведомлений от бота)', type: 'number' },
      { name: 'sort_order', label: 'Порядок', type: 'number' },
      { name: 'is_active', label: 'Показывать на сайте и принимать записи', type: 'checkbox' },
    ],
    row: (m) => `${m.photo_url ? `<img class="adm-thumb" src="${esc(m.photo_url)}" alt="">` : ''}<strong>${esc(m.name)}</strong> <span class="muted">${esc(m.specialization || '')}</span>`,
    extra: (m) => `<fieldset class="adm-checks"><legend>Какие услуги делает</legend>${ref.services.map((s) => `
      <label><input type="checkbox" name="svc" value="${s.id}" ${ref.masterServices.some((x) => x.master_id === m?.id && x.service_id === s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</fieldset>
      ${m ? `<div class="adm-link"><p class="muted">${m.telegram_chat_id ? 'Telegram привязан.' : 'Telegram не привязан: мастер не получает уведомления.'}</p>
        <button class="btn btn--small btn--ghost" type="button" data-link-tg="${m.id}">Ссылка для привязки Telegram</button>
        <p class="adm-link__out" aria-live="polite"></p></div>` : ''}`,
    async afterSave(id, form) {
      const ids = [...form.querySelectorAll('[name="svc"]:checked')].map((c) => c.value);
      const del = await sb.from('master_services').delete().eq('master_id', id);
      if (del.error) throw del.error;
      if (ids.length) {
        const ins = await sb.from('master_services').insert(ids.map((service_id) => ({ master_id: id, service_id })));
        if (ins.error) throw ins.error;
      }
    },
  },
  gallery: {
    table: 'gallery', one: 'фото',
    fields: [
      { name: 'image_url', label: 'Фото', type: 'image', folder: 'gallery', required: true },
      { name: 'caption', label: 'Подпись' },
      { name: 'master_id', label: 'Чья работа', type: 'select', options: () => [['', '—'], ...ref.masters.map((m) => [m.id, m.name])] },
      { name: 'sort_order', label: 'Порядок', type: 'number' },
      { name: 'is_active', label: 'Показывать на сайте', type: 'checkbox' },
    ],
    row: (g) => `<img class="adm-thumb" src="${esc(g.image_url)}" alt=""><span>${esc(g.caption || 'Без подписи')}</span>`,
  },
  reviews: {
    table: 'reviews', one: 'отзыв',
    fields: [
      { name: 'author_name', label: 'Имя', required: true },
      { name: 'text', label: 'Текст', type: 'textarea', required: true },
      { name: 'rating', label: 'Оценка', type: 'select', options: () => [5, 4, 3, 2, 1].map((n) => [n, `${n} из 5`]) },
      { name: 'sort_order', label: 'Порядок', type: 'number' },
      { name: 'is_active', label: 'Показывать на сайте', type: 'checkbox' },
    ],
    row: (r) => `<strong>${esc(r.author_name)}</strong> <span class="muted">${r.rating} из 5</span>${r.source === 'bot' ? ' <span class="tag">из бота</span>' : ''}<span class="adm-clip">${esc(r.text)}</span>`,
  },
};

async function renderEntity(key) {
  const cfg = ENTITIES[key];
  const view = document.getElementById('view');
  const { data, error } = await sb.from(cfg.table).select('*').order('sort_order').order('created_at');
  if (error) return fail(error, 'Не загрузилось');
  view.innerHTML = `
    <div class="adm-bar"><h1 class="adm-h1">${TABS[key]}</h1><button class="btn btn--small" type="button" data-new>Добавить ${cfg.one}</button></div>
    <ul class="adm-list" role="list">${data.map((item) => `
      <li class="adm-item${item.is_active === false ? ' is-off' : ''}">
        <div class="adm-item__main">${cfg.row(item)}${item.is_active === false ? ' <span class="tag">скрыто</span>' : ''}</div>
        <div class="adm-item__actions">
          <button class="btn btn--small btn--ghost" type="button" data-edit="${item.id}">Изменить</button>
          <button class="btn btn--small btn--ghost btn--danger" type="button" data-del="${item.id}">Удалить</button>
        </div>
      </li>`).join('') || '<li class="muted">Пока пусто.</li>'}</ul>`;
  view.querySelector('[data-new]').onclick = () => openEditor(key, null);
  view.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openEditor(key, data.find((x) => x.id === b.dataset.edit)));
  view.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Удалить? Отменить будет нельзя.')) return;
    const { error: e } = await sb.from(cfg.table).delete().eq('id', b.dataset.del);
    if (e) return fail(e.code === '23503' ? { message: 'у него есть записи. Лучше снимите галочку «Показывать на сайте»' } : e, 'Не удалено');
    toast('Удалено');
    await loadRef();
    renderEntity(key);
  });
}

function fieldHtml(f, v) {
  const id = `f-${f.name}`;
  const req = f.required ? 'required' : '';
  if (f.type === 'checkbox') return `<label class="adm-check"><input type="checkbox" name="${f.name}" ${v ?? true ? 'checked' : ''}> ${f.label}</label>`;
  if (f.type === 'textarea') return `<div class="field"><label for="${id}">${f.label}</label><textarea id="${id}" name="${f.name}" rows="3" ${req}>${esc(v)}</textarea></div>`;
  if (f.type === 'select') return `<div class="field"><label for="${id}">${f.label}</label><select id="${id}" name="${f.name}">${f.options().map(([k, l]) => `<option value="${k}" ${String(k) === String(v ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  if (f.type === 'image') return `<div class="field"><label for="${id}">${f.label}</label>
    <div class="adm-image">${v ? `<img src="${esc(v)}" alt="">` : ''}</div>
    <input id="${id}" type="file" accept="image/jpeg,image/png,image/webp" data-image="${f.name}" ${req && !v ? 'required' : ''}>
    <input type="hidden" name="${f.name}" value="${esc(v)}"></div>`;
  return `<div class="field"><label for="${id}">${f.label}</label><input id="${id}" name="${f.name}" type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''} value="${esc(v)}" ${req}></div>`;
}

function openEditor(key, item) {
  const cfg = ENTITIES[key];
  const dlg = document.getElementById('edit');
  dlg.innerHTML = `<form class="adm-form">
    <h2 class="adm-h2" id="edit-title">${item ? 'Изменить' : 'Добавить'} ${cfg.one}</h2>
    ${cfg.fields.map((f) => fieldHtml(f, item?.[f.name])).join('')}
    ${cfg.extra ? cfg.extra(item) : ''}
    <div class="adm-actions"><button class="btn" type="submit">Сохранить</button><button class="btn btn--ghost" type="button" data-cancel>Отмена</button></div>
  </form>`;
  const form = dlg.querySelector('form');
  dlg.querySelector('[data-cancel]').onclick = () => dlg.close();
  const linkBtn = dlg.querySelector('[data-link-tg]');
  if (linkBtn) linkBtn.onclick = async () => {
    const out = dlg.querySelector('.adm-link__out');
    const { data: code, error } = await sb.rpc('create_master_link_code', { p_master_id: linkBtn.dataset.linkTg });
    if (error) return fail(error, 'Код не создан');
    const url = botUsername ? `https://t.me/${botUsername}?start=m_${code}` : null;
    out.innerHTML = url
      ? `Отправьте мастеру ссылку, она действует 30 минут: <a class="link" href="${url}" target="_blank" rel="noopener">${url}</a>`
      : `Код: <strong>${esc(code)}</strong>. Бот ещё не подключён, ссылка появится после запуска бота.`;
    if (url) navigator.clipboard?.writeText(url).then(() => toast('Ссылка скопирована')).catch(() => {});
  };
  form.querySelectorAll('[data-image]').forEach((input) => input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const preview = input.previousElementSibling;
    preview.innerHTML = '<p class="muted">Загружаем фото…</p>';
    try {
      const url = await uploadImage(file, cfg.fields.find((f) => f.name === input.dataset.image).folder);
      form.elements[input.dataset.image].value = url;
      preview.innerHTML = `<img src="${esc(url)}" alt="">`;
    } catch (e) {
      preview.innerHTML = '';
      fail(e, 'Фото не загрузилось');
    }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const row = {};
    for (const f of cfg.fields) {
      const el = form.elements[f.name];
      if (f.type === 'checkbox') row[f.name] = el.checked;
      else if (f.type === 'number') row[f.name] = el.value === '' ? (f.name === 'sort_order' ? 0 : null) : Number(el.value);
      else if (f.name === 'rating') row[f.name] = Number(el.value);
      else row[f.name] = el.value.trim() || null;
    }
    if (cfg.fields.some((f) => f.type === 'image' && f.required && !row[f.name])) return toast('Загрузите фото', 'error');
    const q = item ? sb.from(cfg.table).update(row).eq('id', item.id).select().single() : sb.from(cfg.table).insert(row).select().single();
    const { data, error } = await q;
    if (error) return fail(error);
    try { await cfg.afterSave?.(data.id, form); } catch (err) { return fail(err); }
    dlg.close();
    toast('Сохранено. На сайте уже видно.');
    await loadRef();
    renderEntity(key);
  };
  dlg.showModal();
}

// ─── График и выходные ───
let scheduleMaster = null;
async function renderSchedule() {
  const view = document.getElementById('view');
  scheduleMaster ||= ref.masters[0]?.id;
  if (!scheduleMaster) return (view.innerHTML = '<p>Сначала добавьте мастера.</p>');
  const today = dayKey(Date.now());
  const [wh, off] = await Promise.all([
    sb.from('working_hours').select('*').eq('master_id', scheduleMaster).order('weekday').order('start_time'),
    sb.from('days_off').select('*').gte('day', today).order('day'),
  ]);
  if (wh.error || off.error) return fail(wh.error || off.error, 'Не загрузился график');
  const t = (v) => v.slice(0, 5);
  view.innerHTML = `
    <div class="adm-bar"><h1 class="adm-h1">График</h1>
      <div class="adm-seg" role="group" aria-label="Мастер">${ref.masters.map((m) => `<button class="btn btn--small ${m.id === scheduleMaster ? '' : 'btn--ghost'}" type="button" data-m="${m.id}" aria-pressed="${m.id === scheduleMaster}">${esc(m.name)}</button>`).join('')}</div>
    </div>
    <form class="adm-week" id="week">
      ${WEEKDAYS.map((name, i) => {
        const rows = wh.data.filter((r) => r.weekday === i + 1);
        return `<fieldset class="adm-wd" data-wd="${i + 1}"><legend>${name}</legend>
          <div class="adm-intervals">${rows.map((r) => interval(t(r.start_time), t(r.end_time))).join('') || '<p class="muted adm-free-day">Выходной</p>'}</div>
          <button class="btn btn--small btn--ghost" type="button" data-add-int>Добавить часы</button></fieldset>`;
      }).join('')}
      <div class="adm-actions"><button class="btn" type="submit">Сохранить график</button></div>
    </form>
    <h2 class="adm-h2">Выходные и отпуска</h2>
    <form class="adm-row adm-off" id="off">
      <div class="field"><label for="off-day">Дата</label><input id="off-day" name="day" type="date" min="${today}" required></div>
      <div class="field"><label for="off-master">Кто</label><select id="off-master" name="master"><option value="">Всё заведение</option>${ref.masters.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="off-reason">Причина</label><input id="off-reason" name="reason" placeholder="Например: отпуск"></div>
      <button class="btn btn--small" type="submit">Добавить</button>
    </form>
    <ul class="adm-list" role="list">${off.data.map((o) => `<li class="adm-item"><div class="adm-item__main"><strong>${esc(longDay(o.day))}</strong> <span class="muted">${o.master_id ? esc(masterName(o.master_id)) : 'всё заведение'}${o.reason ? `, ${esc(o.reason)}` : ''}</span></div>
      <button class="btn btn--small btn--ghost btn--danger" type="button" data-del-off="${o.id}">Удалить</button></li>`).join('') || '<li class="muted">Ближайших выходных нет.</li>'}</ul>`;

  view.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => { scheduleMaster = b.dataset.m; renderSchedule(); });
  view.querySelector('#week').addEventListener('click', (e) => {
    if (e.target.closest('[data-add-int]')) {
      const box = e.target.closest('fieldset').querySelector('.adm-intervals');
      box.querySelector('.adm-free-day')?.remove();
      box.insertAdjacentHTML('beforeend', interval('10:00', '20:00'));
    }
    if (e.target.closest('[data-del-int]')) e.target.closest('.adm-int').remove();
  });
  view.querySelector('#week').onsubmit = async (e) => {
    e.preventDefault();
    const rows = [...e.target.querySelectorAll('.adm-wd')].flatMap((fs) => [...fs.querySelectorAll('.adm-int')].map((r) => ({
      master_id: scheduleMaster, weekday: Number(fs.dataset.wd),
      start_time: r.querySelector('[name="start"]').value, end_time: r.querySelector('[name="end"]').value,
    })));
    const bad = rows.find((r) => !r.start_time || !r.end_time || r.end_time <= r.start_time);
    if (bad) return toast(`${WEEKDAYS[bad.weekday - 1]}: конец смены должен быть позже начала`, 'error');
    const del = await sb.from('working_hours').delete().eq('master_id', scheduleMaster);
    if (del.error) return fail(del.error);
    if (rows.length) {
      const ins = await sb.from('working_hours').insert(rows);
      if (ins.error) return fail(ins.error);
    }
    toast('График сохранён');
    renderSchedule();
  };
  view.querySelector('#off').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const { error } = await sb.from('days_off').insert({ day: f.day.value, master_id: f.master.value || null, reason: f.reason.value || null });
    if (error) return fail(error.code === '23505' ? { message: 'этот день уже отмечен' } : error);
    toast('Выходной добавлен');
    renderSchedule();
  };
  view.querySelectorAll('[data-del-off]').forEach((b) => b.onclick = async () => {
    if (!confirm('Удалить выходной?')) return;
    const { error } = await sb.from('days_off').delete().eq('id', b.dataset.delOff);
    if (error) return fail(error, 'Не удалено');
    renderSchedule();
  });
}

const interval = (s, e) => `<div class="adm-int">
  <label>с <input type="time" name="start" value="${s}" step="900" required></label>
  <label>до <input type="time" name="end" value="${e}" step="900" required></label>
  <button class="btn btn--small btn--ghost" type="button" data-del-int aria-label="Убрать интервал">Убрать</button></div>`;

// ─── Telegram-бот: администраторы и заблокированные клиенты ───
async function renderBot() {
  const view = document.getElementById('view');
  const [admins, blocked] = await Promise.all([
    sb.from('bot_admins').select('*').order('created_at'),
    sb.from('clients').select('*').eq('blocked', true).order('updated_at', { ascending: false }),
  ]);
  if (admins.error || blocked.error) return fail(admins.error || blocked.error, 'Не загрузилось');
  const link = botUsername ? `<a class="link" href="https://t.me/${esc(botUsername)}" target="_blank" rel="noopener">@${esc(botUsername)}</a>` : 'ещё не подключён';
  view.innerHTML = `
    <h1 class="adm-h1">Бот</h1>
    <p>Бот: ${link}. Мастера привязываются ссылкой из карточки мастера.</p>
    <h2 class="adm-h2">Администраторы бота</h2>
    <p class="muted">Получают все уведомления, видят статистику, делают рассылку. Свой Telegram ID человек узнаёт командой /id в боте.</p>
    <form class="adm-row adm-off" id="bot-admin">
      <div class="field"><label for="ba-id">Telegram ID</label><input id="ba-id" name="tgid" inputmode="numeric" pattern="\\d{5,15}" required></div>
      <div class="field"><label for="ba-name">Кто это</label><input id="ba-name" name="name" placeholder="Например: Ольга, управляющая"></div>
      <button class="btn btn--small" type="submit">Добавить</button>
    </form>
    <ul class="adm-list" role="list">${admins.data.map((a) => `<li class="adm-item"><div class="adm-item__main"><strong>${esc(a.name || 'Без имени')}</strong> <span class="muted">${a.telegram_id}</span></div>
      <button class="btn btn--small btn--ghost btn--danger" type="button" data-del-admin="${a.telegram_id}">Удалить</button></li>`).join('') || '<li class="muted">Пока никого.</li>'}</ul>
    <h2 class="adm-h2">Заблокированные клиенты</h2>
    <ul class="adm-list" role="list">${blocked.data.map((c) => `<li class="adm-item"><div class="adm-item__main"><strong>${esc(c.name || 'Без имени')}</strong> <span class="muted">${esc(c.phone || '')} ${c.telegram_id ? `Telegram ${c.telegram_id}` : ''}</span></div>
      <button class="btn btn--small btn--ghost" type="button" data-unblock="${c.id}">Разблокировать</button></li>`).join('') || '<li class="muted">Никто не заблокирован.</li>'}</ul>`;
  view.querySelector('#bot-admin').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const { error } = await sb.from('bot_admins').insert({ telegram_id: Number(f.elements.tgid.value), name: f.elements.name.value.trim() || null });
    if (error) return fail(error.code === '23505' ? { message: 'этот ID уже в списке' } : error);
    toast('Администратор бота добавлен');
    renderBot();
  };
  view.querySelectorAll('[data-del-admin]').forEach((b) => b.onclick = async () => {
    if (!confirm('Убрать из администраторов бота?')) return;
    const { error } = await sb.from('bot_admins').delete().eq('telegram_id', b.dataset.delAdmin);
    if (error) return fail(error, 'Не удалено');
    renderBot();
  });
  view.querySelectorAll('[data-unblock]').forEach((b) => b.onclick = async () => {
    const { error } = await sb.from('clients').update({ blocked: false }).eq('id', b.dataset.unblock);
    if (error) return fail(error);
    toast('Клиент разблокирован');
    renderBot();
  });
}

// ─── Старт ───
async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderLogin();
  if (shownFor === session.user.email) return;
  const { data: ok, error } = await sb.rpc('is_admin');
  if (error) return renderLogin(`Ошибка проверки доступа: ${error.message}`);
  if (!ok) return renderDenied(session.user.email);
  renderShell(session.user.email);
}

// Вызовы Supabase внутри onAuthStateChange откладываем, иначе клиент может зависнуть.
// События идут пачкой (INITIAL_SESSION, SIGNED_IN), поэтому start выполняем строго по очереди.
let queue = Promise.resolve();
sb.auth.onAuthStateChange((event) => {
  if (!['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'].includes(event)) return;
  setTimeout(() => { queue = queue.then(start, start); }, 0);
});
