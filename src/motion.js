// Общие параметры анимаций. anime.js отвечает только за hero и логотип, Motion — за всё остальное.
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const ease = [0.22, 1, 0.36, 1];
export const dur = { fast: 0.18, normal: 0.32, slow: 0.6 };
export const spring = { type: 'spring', stiffness: 320, damping: 30 };
