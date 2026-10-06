import '@fontsource/oranienbaum';
import '@fontsource-variable/golos-text';
import './style.css';
import { createTimeline, createDrawable, splitText, stagger as aStagger } from 'animejs';
import { animate, inView, press } from 'motion';
import { fetchPublicData, renderServices, renderMasters, renderGallery, renderReviews } from './render.js';
import { reduced, ease, dur, spring } from './motion.js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

let data = JSON.parse(document.getElementById('site-data')?.textContent || 'null')
  || { services: [], masters: [], masterServices: [], gallery: [], reviews: [], timezone: 'Europe/Moscow' };

// ─── Hero: один таймлайн anime.js при загрузке ───
function heroIntro() {
  if (reduced) return;
  const title = document.querySelector('.hero__title');
  const parts = ['.hero__title', '.razor', '.hero__kind', '.brand__mark'].map((s) => document.querySelector(s)).filter(Boolean);
  parts.forEach((el) => el.classList.add('is-anim'));
  title.style.opacity = 1;
  document.querySelector('.razor').style.opacity = 1;
  const mark = document.querySelector('.brand__mark');
  if (mark) mark.style.opacity = 1;

  const { chars } = splitText(title, { chars: true });
  const tl = createTimeline({ defaults: { ease: 'outExpo' } });
  tl.add(chars, { opacity: [0, 1], y: ['0.28em', '0em'], duration: 1100, delay: aStagger(70) }, 0)
    .add(createDrawable('.razor__edge'), { draw: ['0 0', '0 1'], duration: 1200, ease: 'inOutQuart' }, 280)
    .add('.hero__kind', { opacity: [0, 1], y: [8, 0], duration: 700 }, 900);
  if (mark) tl.add(createDrawable('.brand__mark path'), { draw: ['0 0', '0 1'], duration: 900, ease: 'inOutSine', delay: aStagger(180) }, 150);
}

// ─── Появление при скролле (Motion): только прайс и мастера ───
function reveal(selector) {
  document.querySelectorAll(selector).forEach((el) => {
    if (reduced) return;
    el.classList.add('is-anim');
    inView(el, () => {
      const i = [...el.parentNode.children].indexOf(el);
      animate(el, { opacity: [0, 1], y: [18, 0] }, { duration: dur.slow, ease, delay: (i % 4) * 0.06 });
    }, { margin: '0px 0px -8% 0px' });
  });
}

function pressFeedback(root = document) {
  if (reduced) return;
  press(root.querySelectorAll('.btn'), (el) => {
    animate(el, { scale: 0.97 }, { duration: dur.fast, ease });
    return () => animate(el, { scale: 1 }, spring);
  });
}

// ─── Свежие данные: если в админке что-то поменяли после сборки ───
async function refresh() {
  try {
    const fresh = await fetchPublicData(SUPABASE_URL, SUPABASE_KEY);
    if (JSON.stringify(fresh) === JSON.stringify(data)) return;
    data = fresh;
    const slots = {
      services: renderServices(data.services),
      masters: renderMasters(data.masters),
      gallery: renderGallery(data.gallery),
      reviews: renderReviews(data.reviews),
    };
    for (const [name, html] of Object.entries(slots)) {
      const el = document.querySelector(`[data-slot="${name}"]`);
      el.innerHTML = html;
      el.querySelectorAll('.price-row, .master').forEach((n) => { n.classList.add('is-anim'); n.style.opacity = 1; });
    }
    pressFeedback(document.querySelector('.masters'));
  } catch (err) {
    console.warn('Не удалось обновить данные:', err.message);
  }
}

// ─── Запись: модуль грузится при первом нажатии ───
let bookingModule;
async function book(opts) {
  bookingModule ||= import('./booking.js');
  (await bookingModule).openBooking(opts, data);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-book], [data-book-service], [data-book-master], [data-lightbox]');
  if (!t) return;
  if (t.dataset.lightbox != null) return openLightbox(Number(t.dataset.lightbox));
  book({ serviceId: t.dataset.bookService, masterId: t.dataset.bookMaster });
});

// ─── Лайтбокс (Motion) ───
const lb = document.getElementById('lightbox');
const lbFig = lb.querySelector('.lightbox__fig');
const lbImg = document.createElement('img');
lbFig.prepend(lbImg);
let lbIndex = 0;

function showPhoto(i, dir = 0) {
  const items = data.gallery;
  if (!items.length) return;
  lbIndex = (i + items.length) % items.length;
  const g = items[lbIndex];
  lbImg.src = g.image_url;
  lbImg.alt = g.caption || 'Работа мастера';
  lbFig.querySelector('figcaption').textContent = g.caption || '';
  if (!reduced && dir) animate(lbImg, { opacity: [0, 1], x: [dir * 24, 0] }, { duration: dur.normal, ease });
}

function openLightbox(i) {
  showPhoto(i);
  lb.showModal();
  document.documentElement.style.overflow = 'hidden';
  if (!reduced) animate(lbFig, { opacity: [0, 1], scale: [0.96, 1] }, { duration: dur.normal, ease });
}

lb.addEventListener('close', () => { document.documentElement.style.overflow = ''; });
lb.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]') || e.target === lb) lb.close();
  else if (e.target.closest('[data-prev]')) showPhoto(lbIndex - 1, -1);
  else if (e.target.closest('[data-next]')) showPhoto(lbIndex + 1, 1);
});
lb.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') showPhoto(lbIndex - 1, -1);
  if (e.key === 'ArrowRight') showPhoto(lbIndex + 1, 1);
});
// Свайп по фото на телефоне.
let touchX = null;
lb.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
lb.addEventListener('touchend', (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 50) showPhoto(lbIndex + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
  touchX = null;
});

heroIntro();
reveal('.price-row');
reveal('.master');
pressFeedback();
refresh();
