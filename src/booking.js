// Онлайн-запись: услуга → мастер → дата и время → контакты → готово.
// Слоты и создание записи — RPC в Supabase (get_free_slots, create_booking), та же функция будет у бота.
import { animate } from 'motion';
import site from './config.js';
import { esc, price, duration } from './render.js';
import { reduced, ease, dur } from './motion.js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const DAYS_AHEAD = 14;
const TOTAL_STEPS = 4;
const PHONE_HREF = site.phone.replace(/[^\d+]/g, '');

const dlg = document.getElementById('booking');
const body = dlg.querySelector('.sheet__body');
const stepLabel = dlg.querySelector('.sheet__step');
const titleEl = dlg.querySelector('.sheet__title');
const backBtn = dlg.querySelector('[data-back]');
const progress = dlg.querySelector('.sheet__progress span');

let data;
let state;

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.message || `HTTP ${res.status}`), { code: json?.message });
  return json;
}

// ─── Время в часовом поясе заведения ───
const fmt = (opts) => new Intl.DateTimeFormat('ru-RU', { timeZone: data.timezone, ...opts });
const dayKeyOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: data.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const timeOf = (iso) => fmt({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const hourOf = (iso) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: data.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
const longDate = (iso) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));

function nextDays() {
  const [y, m, d] = dayKeyOf(new Date().toISOString()).split('-').map(Number);
  return Array.from({ length: DAYS_AHEAD }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 1, d + i));
    const u = (opts) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', ...opts }).format(date);
    return { key: date.toISOString().slice(0, 10), wd: i === 0 ? 'сегодня' : u({ weekday: 'short' }), num: u({ day: 'numeric' }), mon: u({ month: 'short' }) };
  });
}

const service = () => data.services.find((s) => s.id === state.serviceId);
const master = (id = state.masterId) => data.masters.find((m) => m.id === id);
const mastersFor = (serviceId) => {
  const ids = new Set(data.masterServices.filter((ms) => ms.service_id === serviceId).map((ms) => ms.master_id));
  return data.masters.filter((m) => ids.has(m.id));
};
const servicesFor = (masterId) => {
  if (!masterId) return data.services;
  const ids = new Set(data.masterServices.filter((ms) => ms.master_id === masterId).map((ms) => ms.service_id));
  return data.services.filter((s) => ids.has(s.id));
};

// ─── Шаги ───
const steps = {
  service: {
    n: 1, title: 'Услуга',
    render() {
      const list = servicesFor(state.masterId);
      const who = state.masterId ? `<p class="step__hint">Услуги, которые делает ${esc(master().name)}.</p>` : '';
      return `${who}<ul class="choices" role="list">${list.map((s) => `
        <li><button class="choice${s.id === state.serviceId ? ' is-selected' : ''}" type="button" data-service="${s.id}">
          <span class="choice__title">${esc(s.name)}</span>
          <span class="choice__meta">${duration(s.duration_min)}</span>
          <span class="choice__side">${price(s.price)}</span>
        </button></li>`).join('')}</ul>`;
    },
    click(t) {
      const id = t.closest('[data-service]')?.dataset.service;
      if (!id) return;
      state.serviceId = id;
      state.slot = null;
      // Мастер уже выбран (кнопка «Записаться к этому мастеру») — сразу ко времени.
      go(state.masterChosen ? 'time' : 'master');
    },
  },

  master: {
    n: 2, title: 'Мастер',
    render() {
      const list = mastersFor(state.serviceId);
      const person = (m) => `
        <li><button class="choice choice--person${state.masterChosen && state.masterId === m.id ? ' is-selected' : ''}" type="button" data-master="${m.id}">
          ${m.photo_url ? `<img class="choice__avatar" src="${esc(m.photo_url)}" alt="" width="52" height="52">` : '<span class="choice__avatar"></span>'}
          <span class="choice__title">${esc(m.name)}</span>
          <span class="choice__meta">${esc(m.specialization || '')}</span>
        </button></li>`;
      return `<ul class="choices" role="list">
        <li><button class="choice choice--person${state.masterChosen && !state.masterId ? ' is-selected' : ''}" type="button" data-master="">
          <span class="choice__avatar choice__avatar--any" aria-hidden="true">∗</span>
          <span class="choice__title">Любой свободный</span>
          <span class="choice__meta">Покажем больше времени</span>
        </button></li>
        ${list.map(person).join('')}</ul>`;
    },
    click(t) {
      const el = t.closest('[data-master]');
      if (!el) return;
      state.masterId = el.dataset.master || null;
      state.masterChosen = true;
      state.slot = null;
      go('time');
    },
  },

  time: {
    n: 3, title: 'Дата и время',
    render() {
      if (!state.slots) return '<p class="loading">Смотрим свободное время…</p>';
      const byDay = new Map();
      for (const s of state.slots) {
        const k = dayKeyOf(s.starts_at);
        if (!byDay.has(k)) byDay.set(k, new Map());
        byDay.get(k).set(s.starts_at, s); // у «любого мастера» одно время бывает у нескольких — показываем один раз
      }
      const days = nextDays();
      if (!state.day || !byDay.has(state.day)) state.day = days.find((d) => byDay.has(d.key))?.key;
      if (!state.day) {
        return `${state.notice ? `<p class="form-error" role="alert">${esc(state.notice)}</p>` : ''}
          <p>На ближайшие две недели свободного времени нет${state.masterId ? ' у этого мастера' : ''}.</p>
          ${state.masterId ? '<p><button class="btn btn--ghost" type="button" data-any>Посмотреть у любого мастера</button></p>' : ''}
          <p>Можно позвонить: <a class="link" href="tel:${PHONE_HREF}">${esc(site.phone)}</a></p>`;
      }
      const times = [...byDay.get(state.day).values()];
      const groups = [['Утро', (h) => h < 12], ['День', (h) => h >= 12 && h < 17], ['Вечер', (h) => h >= 17]]
        .map(([label, test]) => [label, times.filter((s) => test(hourOf(s.starts_at)))])
        .filter(([, list]) => list.length);
      return `
        ${state.notice ? `<p class="form-error" role="alert">${esc(state.notice)}</p>` : ''}
        <div class="days" role="group" aria-label="День">
          ${days.map((d) => `<button class="day${d.key === state.day ? ' is-selected' : ''}" type="button" data-day="${d.key}" ${byDay.has(d.key) ? '' : 'disabled'} aria-pressed="${d.key === state.day}" aria-label="${d.wd}, ${d.num} ${d.mon}${byDay.has(d.key) ? '' : ', мест нет'}">
            <span class="day__wd">${d.wd}</span><span class="day__num">${d.num}</span><span class="day__mon">${d.mon}</span>
          </button>`).join('')}
        </div>
        ${groups.map(([label, list]) => `
          <h3 class="slots__label">${label}</h3>
          <div class="slots">${list.map((s) => `<button class="slot" type="button" data-time="${s.starts_at}">${timeOf(s.starts_at)}</button>`).join('')}</div>`).join('')}`;
    },
    async load() {
      state.slots = null;
      try {
        state.slots = await rpc('get_free_slots', {
          p_service_id: state.serviceId,
          p_master_id: state.masterId,
          p_from: nextDays()[0].key,
          p_days: DAYS_AHEAD,
        });
      } catch {
        state.slots = [];
        state.notice = 'Не получилось загрузить время. Проверьте интернет и откройте шаг заново.';
      }
      if (state.step === 'time') paint();
    },
    click(t) {
      if (t.closest('[data-any]')) { state.masterId = null; return go('time', 0); }
      const day = t.closest('[data-day]');
      if (day) { state.day = day.dataset.day; state.notice = ''; return paint(); }
      const slot = t.closest('[data-time]');
      if (slot) { state.slot = slot.dataset.time; state.notice = ''; go('contacts'); }
    },
  },

  contacts: {
    n: 4, title: 'Ваши контакты',
    render() {
      const s = service();
      const saved = loadContact();
      return `
        <div class="summary">
          <strong>${esc(s.name)}, ${price(s.price)}</strong>
          <span>${esc(longDate(state.slot))}, ${timeOf(state.slot)}</span>
          <span class="muted">${state.masterId ? esc(master().name) : 'Любой свободный мастер'}, ${duration(s.duration_min)}</span>
        </div>
        <form class="booking-form" novalidate>
          <p class="form-error" role="alert" hidden></p>
          <div class="field">
            <label for="b-name">Имя</label>
            <input id="b-name" name="name" autocomplete="given-name" required minlength="2" maxlength="80" value="${esc(saved.name)}">
            <span class="field__error" hidden></span>
          </div>
          <div class="field">
            <label for="b-phone">Телефон</label>
            <input id="b-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="+7 900 000-00-00" value="${esc(saved.phone)}" aria-describedby="b-phone-hint">
            <span class="field__hint" id="b-phone-hint">Позвоним, только если что-то поменяется.</span>
            <span class="field__error" hidden></span>
          </div>
          <div class="field">
            <label for="b-comment">Комментарий <span class="muted">(необязательно)</span></label>
            <textarea id="b-comment" name="comment" maxlength="500" rows="2" placeholder="Например: хочу как на фото, пришлю в Telegram"></textarea>
          </div>
          <div class="hp" aria-hidden="true">
            <label for="b-website">Сайт</label>
            <input id="b-website" name="website" tabindex="-1" autocomplete="off">
          </div>
          <button class="btn btn--wide" type="submit">Записаться</button>
          <p class="consent">Нажимая кнопку, вы соглашаетесь, что мы сохраним имя и телефон для этой записи.</p>
        </form>`;
    },
  },

  done: {
    n: 0, title: 'Вы записаны',
    render() {
      const s = service();
      const r = state.result;
      return `<div class="done">
        <p class="done__title">До встречи!</p>
        <p>Ждём вас ${esc(longDate(r.starts_at))} в ${timeOf(r.starts_at)}. Если планы поменяются, позвоните: <a class="link" href="tel:${PHONE_HREF}">${esc(site.phone)}</a>.</p>
        <div class="summary">
          <strong>${esc(s.name)}, ${price(s.price)}</strong>
          <span>Мастер: ${esc(r.master_name)}</span>
          <span>${esc(site.address.street)}, ${esc(site.address.city)}</span>
          <span class="muted">${esc(site.address.note)}</span>
        </div>
        <button class="btn btn--ghost btn--wide" type="button" data-close>Готово</button>
      </div>`;
    },
  },
};

// Имя и телефон запоминаем в браузере, чтобы в следующий раз не вводить.
function loadContact() {
  try { return JSON.parse(localStorage.getItem('booking-contact')) || {}; } catch { return {}; }
}
function saveContact(v) {
  try { localStorage.setItem('booking-contact', JSON.stringify(v)); } catch { /* приватный режим — не страшно */ }
}

function paint() {
  const step = steps[state.step];
  stepLabel.textContent = step.n ? `Шаг ${step.n} из ${TOTAL_STEPS}` : '';
  titleEl.textContent = step.title;
  backBtn.hidden = state.history.length === 0 || state.step === 'done';
  progress.style.setProperty('--p', step.n ? step.n / TOTAL_STEPS : 1);
  body.innerHTML = step.render();
}

function go(name, dir = 1) {
  const from = state.step;
  if (dir > 0 && from && from !== name) state.history.push(from);
  state.step = name;
  const swap = () => {
    paint();
    if (name === 'time') steps.time.load();
    body.scrollTop = 0;
    if (!reduced && from) animate(body, { opacity: [0, 1], x: [dir * 16, 0] }, { duration: dur.normal, ease });
    titleEl.focus({ preventScroll: true });
  };
  if (!reduced && from) animate(body, { opacity: 0, x: -dir * 12 }, { duration: dur.fast, ease }).then(swap);
  else swap();
}

function back() {
  const prev = state.history.pop();
  if (prev) go(prev, -1);
}

const ERRORS = {
  invalid_name: ['name', 'Напишите имя, хотя бы две буквы.'],
  invalid_phone: ['phone', 'Проверьте номер: нужно 10 или 11 цифр.'],
  too_many_bookings: [null, `С этого номера уже есть несколько записей. Позвоните нам, разберёмся: ${site.phone}.`],
  spam_detected: [null, 'Не получилось отправить форму. Обновите страницу и попробуйте ещё раз.'],
};
const SLOT_GONE = ['slot_taken', 'slot_unavailable', 'time_in_past'];

function fieldError(form, name, msg) {
  const field = form.elements[name].closest('.field');
  field.classList.toggle('has-error', !!msg);
  const err = field.querySelector('.field__error');
  err.hidden = !msg;
  err.textContent = msg || '';
  form.elements[name].setAttribute('aria-invalid', msg ? 'true' : 'false');
}

async function submit(form) {
  const name = form.elements.name.value.trim();
  const phone = form.elements.phone.value.trim();
  const digits = phone.replace(/\D/g, '');
  fieldError(form, 'name', name.length < 2 ? ERRORS.invalid_name[1] : '');
  fieldError(form, 'phone', digits.length < 10 || digits.length > 15 ? ERRORS.invalid_phone[1] : '');
  const firstBad = form.querySelector('[aria-invalid="true"]');
  if (firstBad) return firstBad.focus();

  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Записываем…';
  try {
    state.result = await rpc('create_booking', {
      p_service_id: state.serviceId,
      p_master_id: state.masterId,
      p_starts_at: state.slot,
      p_client_name: name,
      p_client_phone: phone,
      p_comment: form.elements.comment.value.trim() || null,
      p_website: form.elements.website.value || null,
    });
    saveContact({ name, phone });
    state.history = [];
    go('done');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Записаться';
    if (SLOT_GONE.includes(err.code)) {
      state.notice = 'Это время только что заняли. Выберите другое.';
      state.history.pop();
      return go('time', -1);
    }
    const [field, msg] = ERRORS[err.code] || [null, err.code
      ? `Не получилось записать. Позвоните нам: ${site.phone}.`
      : 'Не получилось отправить. Проверьте интернет и попробуйте ещё раз.'];
    if (field) return fieldError(form, field, msg);
    const box = form.querySelector('.form-error');
    box.hidden = false;
    box.textContent = msg;
  }
}

function close() {
  const finish = () => { dlg.close(); document.documentElement.style.overflow = ''; };
  if (reduced) return finish();
  animate(dlg, { opacity: 0, y: 24 }, { duration: dur.fast, ease }).then(finish);
}

// ─── События ───
dlg.addEventListener('click', (e) => {
  if (e.target === dlg || e.target.closest('[data-close]')) return close();
  if (e.target.closest('[data-back]')) return back();
  steps[state.step].click?.(e.target);
});
dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
dlg.addEventListener('submit', (e) => { e.preventDefault(); submit(e.target); });
titleEl.tabIndex = -1;

export function openBooking({ serviceId, masterId } = {}, siteData) {
  data = siteData;
  state = {
    step: null, history: [],
    serviceId: serviceId || null,
    masterId: masterId || null,
    masterChosen: !!masterId,
    slot: null, slots: null, day: null, notice: '', result: null,
  };
  // С кнопки услуги в прайсе — сразу к мастеру, «назад» вернёт к услугам.
  if (serviceId) { state.step = 'service'; go('master'); } else go('service');
  if (!dlg.open) {
    dlg.showModal();
    document.documentElement.style.overflow = 'hidden';
    if (!reduced) {
      const mobile = matchMedia('(max-width: 767px)').matches;
      animate(dlg, mobile ? { opacity: [1, 1], y: ['100%', '0%'] } : { opacity: [0, 1], y: [24, 0] }, { duration: dur.normal, ease });
    }
  }
}
