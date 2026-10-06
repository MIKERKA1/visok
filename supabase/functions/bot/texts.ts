// Все тексты бота. Под нового клиента правится этот файл и src/config.js (название, адрес, телефон).
// Пишем на «вы», коротко, как администратор за стойкой. Эмодзи не больше одного на сообщение.

const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
export { esc };

export const T = {
  // ─── Меню ───
  start: (name: string, shop: string) =>
    `Здравствуйте${name ? `, ${esc(name)}` : ''}. Это бот барбершопа «${esc(shop)}».\nЗдесь можно записаться, перенести или отменить визит.`,
  menu: 'Что делаем?',
  btn: {
    book: 'Записаться',
    my: 'Мои записи',
    services: 'Услуги и цены',
    masters: 'Мастера',
    address: 'Адрес',
    contact: 'Связаться',
    miniApp: 'Запись в приложении',
    remindersOn: 'Напоминания: включены',
    remindersOff: 'Напоминания: выключены',
    back: '‹ Назад',
    cancel: 'Отмена',
    menu: 'В меню',
    confirm: 'Записаться',
    any: 'Любой свободный',
    sharePhone: 'Отправить мой номер',
    reschedule: 'Перенести',
    cancelBooking: 'Отменить',
    yesCancel: 'Да, отменить',
    keep: 'Нет, оставить',
    willCome: 'Приду',
    bookMaster: 'Записаться к мастеру',
    prev: '‹',
    next: '›',
    skip: 'Пропустить',
    today: 'Сегодня',
    tomorrow: 'Завтра',
    closeTime: 'Закрыть время',
    came: 'Пришёл',
    noShow: 'Не пришёл',
    adminDay: 'Записи на день',
    adminBook: 'Записать клиента',
    stats: 'Статистика',
    broadcast: 'Рассылка',
    block: 'Блокировка',
    week: 'Неделя',
    month: 'Месяц',
    send: 'Отправить',
  },

  // ─── Запись ───
  stepService: 'Выберите услугу.',
  stepMaster: (service: string) => `${esc(service)}. К кому записать?`,
  stepDay: (service: string, master: string) => `🗓 ${esc(service)}, ${esc(master)}.\nВыберите день.`,
  stepSlot: (service: string, master: string, day: string) => `🗓 ${esc(service)}, ${esc(master)}, ${esc(day)}.\nВыберите время.`,
  noDays: 'На ближайшие две недели свободного времени нет. Попробуйте другого мастера или позвоните нам.',
  askPhone: 'Оставьте номер телефона, чтобы мастер мог связаться, если что-то поменяется. Нажмите кнопку ниже или напишите номер.',
  phoneSaved: 'Спасибо, номер сохранили.',
  badPhone: 'Не похоже на номер. Напишите 10 или 11 цифр, например 8 999 123-45-67.',
  confirm: (service: string, price: string, master: string, when: string) =>
    `Проверьте запись:\n\n<b>${esc(service)}</b>, ${esc(price)}\n🗓 ${esc(when)}\nМастер: ${esc(master)}`,
  booked: (when: string, master: string, address: string) =>
    `Готово, вы записаны.\n🗓 ${esc(when)}, мастер ${esc(master)}.\n${esc(address)}\n\nНапомним за день и за два часа.`,
  slotTaken: 'Это время только что заняли. Вот что свободно сейчас:',
  cancelled: 'Запись не создана. Можно начать заново из меню.',
  tooMany: 'С этого аккаунта сегодня уже несколько записей. Если нужно ещё, позвоните нам.',
  blocked: 'Записаться через бота не получится. Позвоните нам, пожалуйста.',
  anyMaster: 'любой свободный мастер',

  // ─── Мои записи ───
  myEmpty: 'Ближайших записей нет.',
  myTitle: 'Ваши ближайшие записи:',
  myItem: (when: string, service: string, master: string) => `🗓 ${esc(when)}\n${esc(service)}, ${esc(master)}`,
  askCancel: (when: string) => `Отменить запись на ${esc(when)}?`,
  cancelDone: 'Запись отменили. Время освободилось, его увидят другие клиенты.',
  cancelLate: (hours: number, phone: string) => `Отменить или перенести через бота можно не позже чем за ${hours} ч. Позвоните, пожалуйста: ${esc(phone)}`,
  notYours: 'Эта запись не найдена среди ваших.',
  rescheduleDay: (when: string) => `Переносим запись с ${esc(when)}. Выберите новый день.`,
  rescheduled: (when: string) => `Готово, перенесли на ${esc(when)}.`,
  willCome: 'Спасибо, ждём вас.',

  // ─── Справка ───
  servicesTitle: 'Услуги и цены:',
  serviceLine: (name: string, price: string, dur: string) => `<b>${esc(name)}</b>: ${esc(price)}, ${esc(dur)}`,
  masterCard: (name: string, spec: string, exp: string, bio: string) =>
    `<b>${esc(name)}</b>\n${esc(spec)}${exp ? `\n${esc(exp)}` : ''}${bio ? `\n\n${esc(bio)}` : ''}`,
  addressText: (street: string, city: string, note: string, hours: string, parking: string) =>
    `📍 ${esc(street)}, ${esc(city)}\n${esc(note)}\n\nЧасы: ${esc(hours)}\nПарковка: ${esc(parking)}`,
  contactText: (phone: string, admin: string) => `Телефон: ${esc(phone)}\nНаписать администратору: ${esc(admin)}`,
  remindersNowOn: 'Напоминания включены.',
  remindersNowOff: 'Напоминания выключены. Рассылки тоже приходить не будут.',
  miniAppHint: 'Откройте запись в приложении: там всё на одном экране.',

  // ─── Напоминания и отзывы ───
  remind24: (when: string, service: string, master: string) => `Напоминаем: завтра у вас запись.\n🗓 ${esc(when)}\n${esc(service)}, мастер ${esc(master)}.`,
  remind2: (when: string, service: string, master: string) => `Через два часа ждём вас.\n🗓 ${esc(when)}\n${esc(service)}, мастер ${esc(master)}.`,
  remindCallToCancel: (phone: string) => `Если не успеваете, позвоните: ${esc(phone)}`,
  askReview: (master: string) => `Как прошёл визит к мастеру ${esc(master)}? Поставьте оценку от 1 до 5.`,
  askReviewComment: 'Спасибо. Пару слов о визите? Напишите сообщением или нажмите «Пропустить».',
  reviewThanks: 'Спасибо за отзыв.',

  // ─── Мастер ───
  masterLinked: (name: string) => `Готово, вы привязаны как мастер ${esc(name)}. Сюда будут приходить новые записи, отмены и переносы.`,
  linkBad: 'Код не подошёл или устарел. Попросите администратора создать новый в админке сайта.',
  dayTitle: (day: string) => `🗓 ${esc(day)}`,
  dayEmpty: (day: string) => `🗓 ${esc(day)}: записей нет.`,
  dayItem: (time: string, client: string, phone: string, service: string, status: string) =>
    `<b>${esc(time)}</b> ${esc(client)}, ${esc(phone)}\n${esc(service)}${status ? `, ${esc(status)}` : ''}`,
  marked: (status: string) => `Отметили: ${esc(status)}.`,
  closeMenu: 'Что закрыть? Новые записи на это время не пройдут.',
  closeHour: 'Ближайший час',
  closeRestOfDay: 'До конца сегодня',
  closeTomorrow: 'Весь завтрашний день',
  closedBlock: (from: string, to: string) => `Закрыли время с ${esc(from)} до ${esc(to)}.`,
  closedDay: (day: string) => `Закрыли весь день: ${esc(day)}.`,
  closeNothing: 'Сегодня рабочий день уже закончился.',
  noAccess: 'Эта команда не для вас.',

  // ─── Уведомления мастеру и админу ───
  nNew: (when: string, client: string, phone: string, service: string, master: string, source: string) =>
    `Новая запись (${esc(source)})\n🗓 ${esc(when)}\n${esc(client)}, ${esc(phone)}\n${esc(service)}, мастер ${esc(master)}`,
  nCancel: (when: string, client: string, service: string, master: string) =>
    `Запись отменена\n🗓 ${esc(when)}\n${esc(client)}, ${esc(service)}, мастер ${esc(master)}`,
  nMove: (from: string, to: string, client: string, master: string) =>
    `Запись перенесена\n${esc(from)} → 🗓 ${esc(to)}\n${esc(client)}, мастер ${esc(master)}`,
  nLowReview: (rating: number, client: string, master: string, text: string) =>
    `Оценка ${rating} из 5 от ${esc(client)}, мастер ${esc(master)}${text ? `:\n«${esc(text)}»` : ''}`,
  source: { site: 'сайт', bot: 'бот', admin: 'администратор' } as Record<string, string>,
  status: { new: 'новая', confirmed: 'подтверждена', done: 'пришёл', no_show: 'не пришёл', cancelled: 'отменена' } as Record<string, string>,

  // ─── Админ ───
  adminMenu: 'Раздел администратора.',
  adminDayTitle: (day: string, count: number) => `🗓 ${esc(day)}: записей ${count}`,
  adminBookName: 'Как зовут клиента?',
  adminBookPhone: 'Телефон клиента?',
  statsText: (period: string, s: { total: number; cancelled: number; noShow: number; done: number; revenue: string }, load: string) =>
    `Статистика за ${esc(period)}\nЗаписей: ${s.total}\nПришли: ${s.done}\nОтмены: ${s.cancelled}\nНе пришли: ${s.noShow}\nВыручка по прайсу: ${esc(s.revenue)}\n\nЗагрузка мастеров:\n${load}`,
  broadcastAsk: 'Напишите текст рассылки одним сообщением. Его получат клиенты, которые не отключили сообщения.',
  broadcastPreview: (count: number) => `Так увидят сообщение клиенты. Отправить ${count} получателям?`,
  broadcastDone: (sent: number, failed: number) => `Рассылка отправлена: ${sent}, не доставлено: ${failed}.`,
  broadcastCancelled: 'Рассылку отменили.',
  blockAsk: 'Пришлите телефон клиента или его Telegram ID. Повторная отправка того же номера снимет блокировку.',
  blockDone: (who: string) => `Клиент ${esc(who)} заблокирован: записаться через сайт и бота он не сможет.`,
  unblockDone: (who: string) => `Клиент ${esc(who)} разблокирован.`,
  blockBad: 'Не понял. Пришлите телефон (10–11 цифр) или числовой Telegram ID.',

  // ─── Ошибки ───
  error: 'Что-то пошло не так, мы уже разбираемся. Попробуйте ещё раз через минуту или позвоните нам.',
  stale: 'Это сообщение устарело. Откройте меню заново: /start',
  myId: (id: number) => `Ваш Telegram ID: <code>${id}</code>`,
};

// Команды в меню Telegram (setMyCommands).
export const COMMANDS = [
  { command: 'start', description: 'Главное меню' },
  { command: 'book', description: 'Записаться' },
  { command: 'my', description: 'Мои записи' },
  { command: 'today', description: 'Мастеру: записи на сегодня' },
  { command: 'tomorrow', description: 'Мастеру: записи на завтра' },
  { command: 'admin', description: 'Раздел администратора' },
  { command: 'id', description: 'Узнать свой Telegram ID' },
];

export const DESCRIPTION = (shop: string, city: string) =>
  `Запись в барбершоп «${shop}» (${city}): выберите услугу, мастера и время, бот напомнит о визите. Демо-проект.`;
export const SHORT_DESCRIPTION = (shop: string) => `Запись в барбершоп «${shop}» без звонков. Демо-проект.`;
