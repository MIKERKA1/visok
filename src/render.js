// Разметка блоков из данных Supabase. Одни и те же функции работают при сборке (пре-рендер в HTML)
// и в браузере (обновление, если в админке что-то поменяли после сборки).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const rub = new Intl.NumberFormat('ru-RU');
export const price = (n) => `${rub.format(n)} ₽`;

export function plural(n, [one, few, many]) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function duration(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export function renderServices(services) {
  if (!services.length) return '<p class="empty">Прайс скоро появится. Цены можно уточнить по телефону.</p>';
  return `<ul class="price-list" role="list">${services.map((s) => `
    <li class="price-row">
      <button class="price-row__btn" type="button" data-book-service="${esc(s.id)}" aria-label="${esc(s.name)}, ${price(s.price)}, ${duration(s.duration_min)}. Записаться">
        <span class="price-row__line">
          <span class="price-row__name">${esc(s.name)}</span>
          <span class="price-row__dots" aria-hidden="true"></span>
          <span class="price-row__price">${price(s.price)}</span>
        </span>
        <span class="price-row__meta">
          ${s.description ? `<span class="price-row__desc">${esc(s.description)}</span>` : ''}
          <span class="price-row__time">${duration(s.duration_min)}</span>
        </span>
      </button>
    </li>`).join('')}
  </ul>`;
}

export function renderMasters(masters) {
  if (!masters.length) return '<p class="empty">Скоро здесь появятся мастера.</p>';
  return masters.map((m, i) => `
    <article class="master" style="--i:${i}">
      <div class="master__photo">
        ${m.photo_url ? `<img src="${esc(m.photo_url)}" alt="${esc(m.name)}" width="640" height="800" loading="lazy" decoding="async">` : ''}
      </div>
      <h3 class="master__name">${esc(m.name)}</h3>
      <p class="master__spec">${esc(m.specialization || '')}</p>
      ${m.experience_years != null ? `<p class="master__exp">${m.experience_years} ${plural(m.experience_years, ['год', 'года', 'лет'])} в профессии</p>` : ''}
      ${m.bio ? `<p class="master__bio">${esc(m.bio)}</p>` : ''}
      <button class="btn btn--ghost" type="button" data-book-master="${esc(m.id)}" aria-label="Записаться к мастеру: ${esc(m.name)}">Записаться к этому мастеру</button>
    </article>`).join('');
}

export function renderGallery(items) {
  if (!items.length) return '<p class="empty">Фотографии работ скоро появятся.</p>';
  return items.map((g, i) => `
    <figure class="work work--${(i % 5) + 1}">
      <button class="work__btn" type="button" data-lightbox="${i}" aria-label="Открыть фото: ${esc(g.caption || 'работа мастера')}">
        <img src="${esc(g.image_url)}" alt="${esc(g.caption || 'Работа мастера')}" loading="lazy" decoding="async">
      </button>
      ${g.caption ? `<figcaption>${esc(g.caption)}</figcaption>` : ''}
    </figure>`).join('');
}

export function renderReviews(reviews) {
  if (!reviews.length) return '';
  return reviews.map((r) => `
    <blockquote class="review">
      <p class="review__text">${esc(r.text)}</p>
      <footer class="review__by">
        <span>${esc(r.author_name)}</span>
        <span class="review__rating" aria-label="Оценка ${r.rating} из 5">${'★'.repeat(r.rating)}<span class="review__rating-off">${'★'.repeat(5 - r.rating)}</span></span>
      </footer>
    </blockquote>`).join('');
}

// Поля мастера без telegram_chat_id: anon его не видит.
export const MASTER_COLS = 'id,name,photo_url,specialization,experience_years,bio,sort_order';

// Публичные данные сайта одним набором запросов. Работает и в Node (сборка), и в браузере.
export async function fetchPublicData(url, key) {
  const get = async (path) => {
    const res = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key } });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };
  const order = 'order=sort_order.asc,created_at.asc';
  const [services, masters, masterServices, gallery, reviews, settings] = await Promise.all([
    get(`services?select=id,name,description,price,duration_min&is_active=eq.true&${order}`),
    get(`masters?select=${MASTER_COLS}&is_active=eq.true&order=sort_order.asc`),
    get('master_services?select=master_id,service_id'),
    get(`gallery?select=id,image_url,caption&is_active=eq.true&${order}`),
    get(`reviews?select=id,author_name,text,rating&is_active=eq.true&${order}`),
    get('settings?select=timezone'),
  ]);
  return { services, masters, masterServices, gallery, reviews, timezone: settings[0]?.timezone || 'Europe/Moscow' };
}
