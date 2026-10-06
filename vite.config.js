import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import site from './src/config.js';
import { esc, fetchPublicData, renderServices, renderMasters, renderGallery, renderReviews } from './src/render.js';

const DAY_NAMES = { Mo: 'Monday', Tu: 'Tuesday', We: 'Wednesday', Th: 'Thursday', Fr: 'Friday', Sa: 'Saturday', Su: 'Sunday' };

const logoHtml = () => site.logo
  ? `<img class="brand__img" src="${esc(site.logo)}" alt="" height="40">`
  : `<svg class="brand__mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
       <path class="brand__blade" d="M3 21h22c5 0 8-3 9-8H10c-4 0-7 3-7 8z"/>
       <path class="brand__handle" d="M25 21l11 10"/>
     </svg><span class="brand__name">${esc(site.name)}</span>`;

function jsonLd(siteUrl, data) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'HairSalon',
    name: site.name,
    description: site.description,
    url: siteUrl,
    image: `${siteUrl}og.jpg`,
    telephone: site.phone.replace(/[^\d+]/g, ''),
    priceRange: site.priceRange,
    address: {
      '@type': 'PostalAddress',
      streetAddress: site.address.street,
      addressLocality: site.address.city,
      postalCode: site.address.postalCode,
      addressCountry: site.address.country,
    },
    geo: { '@type': 'GeoCoordinates', latitude: site.geo.lat, longitude: site.geo.lon },
    openingHoursSpecification: site.hours.map((h) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: h.days.map((d) => DAY_NAMES[d]),
      opens: h.open,
      closes: h.close,
    })),
    sameAs: site.socials.map((s) => s.url),
  };
  if (data.services.length) {
    ld.hasOfferCatalog = {
      '@type': 'OfferCatalog',
      name: 'Услуги',
      itemListElement: data.services.map((s) => ({
        '@type': 'Offer',
        price: s.price,
        priceCurrency: 'RUB',
        itemOffered: { '@type': 'Service', name: s.name },
      })),
    };
  }
  return JSON.stringify(ld).replace(/</g, '\\u003c');
}

function siteHtml(env) {
  const siteUrl = env.VITE_SITE_URL || '/';
  const { lat, lon } = site.geo;
  const vars = {
    title: `${site.name}: ${site.kind.toLowerCase()} ${site.district}, ${site.address.city}`,
    name: site.name,
    kind: site.kind,
    district: site.district,
    tagline: site.tagline,
    description: site.description,
    siteUrl,
    colorBg: site.colors.bg,
    phone: site.phone,
    phoneHref: site.phone.replace(/[^\d+]/g, ''),
    street: site.address.street,
    city: site.address.city,
    metro: site.address.metro,
    addressNote: site.address.note,
    parking: site.parking,
    hoursShort: site.hours.map((h) => `${esc(h.label)} ${h.open}–${h.close}`).join('<br>'),
    hoursRows: site.hours.map((h) => `<div><dt>${esc(h.label)}</dt><dd>${h.open}–${h.close}</dd></div>`).join(''),
    mapSrc: `https://yandex.ru/map-widget/v1/?ll=${lon}%2C${lat}&z=16&pt=${lon}%2C${lat}%2Cpm2dgl`,
    mapLink: `https://yandex.ru/maps/?pt=${lon},${lat}&z=17&l=map`,
    socials: site.socials.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a></li>`).join(''),
    demo: site.demo?.enabled ? `<p class="foot__demo"><a href="${esc(site.demo.url)}" target="_blank" rel="noopener">${esc(site.demo.text)}</a></p>` : '',
  };
  // Эти значения уже содержат разметку и не экранируются.
  const raw = new Set(['hoursShort', 'hoursRows', 'socials', 'demo']);
  const cssVars = Object.entries(site.colors)
    .map(([k, v]) => `--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${v}`).join(';');
  let data = null;

  return {
    name: 'site-html',
    async transformIndexHtml(html, ctx) {
      // Цвета из конфига — отдельным тегом: инлайн-стили в исходном HTML Vite минифицирует раньше подстановки.
      const tags = [{ tag: 'style', children: `:root{${cssVars}}`, injectTo: 'head' }];
      if (ctx.path.endsWith('admin.html')) {
        return { html: html.replaceAll('{{name}}', esc(site.name)), tags };
      }
      // Снимок данных на момент сборки: блоки видны сразу и без JS, браузер потом подтягивает свежие.
      if (!data) {
        try {
          data = await fetchPublicData(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY);
        } catch (err) {
          console.warn(`data snapshot skipped: ${err.message}`);
          data = { services: [], masters: [], masterServices: [], gallery: [], reviews: [], timezone: 'Europe/Moscow' };
        }
      }
      return { tags, html: html
        .replace('{{jsonLd}}', jsonLd(siteUrl, data))
        .replace('{{logo}}', logoHtml())
        .replace('<!--services-->', renderServices(data.services))
        .replace('<!--masters-->', renderMasters(data.masters))
        .replace('<!--gallery-->', renderGallery(data.gallery))
        .replace('<!--reviews-->', renderReviews(data.reviews))
        .replace('<!--data-->', `<script type="application/json" id="site-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`)
        .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? (raw.has(k) ? vars[k] : esc(vars[k])) : m)) };
    },
    generateBundle() {
      if (!env.VITE_SITE_URL) return;
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nAllow: /\nDisallow: /admin.html\n\nSitemap: ${siteUrl}sitemap.xml\n` });
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteUrl}</loc></url></urlset>\n` });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  return {
    base: './',
    plugins: [siteHtml(env)],
    build: {
      rollupOptions: {
        input: { main: resolve(import.meta.dirname, 'index.html'), admin: resolve(import.meta.dirname, 'admin.html') },
      },
    },
  };
});
