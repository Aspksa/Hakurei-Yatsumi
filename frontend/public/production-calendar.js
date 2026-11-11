// Производственный календарь РФ (пятидневная рабочая неделя) на 2026 и 2027 годы.
// Источники: Постановление Правительства РФ от 24.09.2025 № 1466 («О переносе выходных дней в 2026 году»)
// и Постановление Правительства РФ от 17.09.2026 № 1187 («О переносе выходных дней в 2027 году»).
// Итоги проверяются тестом production-calendar.test.js (247 рабочих / 118 выходных / 1972 ч в оба года).

export const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

const NEW_YEAR = 'Новогодние каникулы';
const FIXED_HOLIDAYS = {
  '01-01': NEW_YEAR, '01-02': NEW_YEAR, '01-03': NEW_YEAR, '01-04': NEW_YEAR, '01-05': NEW_YEAR, '01-06': NEW_YEAR,
  '01-07': 'Рождество Христово', '01-08': NEW_YEAR,
  '02-23': 'День защитника Отечества', '03-08': 'Международный женский день', '05-01': 'Праздник Весны и Труда',
  '05-09': 'День Победы', '06-12': 'День России', '11-04': 'День народного единства'
};

export const PRODUCTION_CALENDAR = {
  2026: {
    decree: 'Постановление Правительства РФ от 24.09.2025 № 1466',
    // Дополнительные выходные, которые попадают на будни: перенос выходных.
    off: {
      '2026-01-09': 'Перенос выходного с субботы 3 января',
      '2026-03-09': 'Перенос выходного с воскресенья 8 марта',
      '2026-05-11': 'Перенос выходного с субботы 9 мая',
      '2026-12-31': 'Перенос выходного с воскресенья 4 января'
    },
    work: {},
    short: ['2026-04-30', '2026-05-08', '2026-06-11', '2026-11-03']
  },
  2027: {
    decree: 'Постановление Правительства РФ от 17.09.2026 № 1187',
    off: {
      '2027-02-22': 'Перенос выходного с субботы 20 февраля',
      '2027-05-03': 'Перенос выходного с субботы 1 мая',
      '2027-05-10': 'Перенос выходного с воскресенья 9 мая',
      '2027-06-14': 'Перенос выходного с субботы 12 июня',
      '2027-11-05': 'Перенос выходного с субботы 2 января',
      '2027-12-31': 'Перенос выходного с воскресенья 3 января'
    },
    work: { '2027-02-20': 'Рабочая суббота (выходной перенесён на 22 февраля)' },
    short: ['2027-02-20', '2027-04-30', '2027-06-11', '2027-11-03']
  }
};

const pad = n => String(n).padStart(2, '0');
export const dateKey = (year, month, day) => `${year}-${pad(month + 1)}-${pad(day)}`;
export const keyOf = date => dateKey(date.getFullYear(), date.getMonth(), date.getDate());
export const parseKey = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
export const hasData = year => Object.hasOwn(PRODUCTION_CALENDAR, year);
export const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

/**
 * Описание дня.
 * kind: 'holiday' (праздник) | 'transfer' (перенесённый выходной) | 'weekend' | 'extra-work' (рабочая суббота) | 'work'
 * off — нерабочий день; short — сокращённый на 1 час; known — есть ли данные производственного календаря.
 */
export function dayInfo(key) {
  const date = parseKey(key), year = date.getFullYear(), weekday = date.getDay();
  const weekend = weekday === 0 || weekday === 6;
  const data = PRODUCTION_CALENDAR[year];
  const holiday = FIXED_HOLIDAYS[key.slice(5)];
  if (!data) {
    return { key, weekday, known: false, kind: weekend ? 'weekend' : 'work', off: weekend, short: false, name: holiday || '', note: '' };
  }
  const short = data.short.includes(key);
  if (data.work[key]) return { key, weekday, known: true, kind: 'extra-work', off: false, short, name: '', note: data.work[key] };
  if (data.off[key]) return { key, weekday, known: true, kind: 'transfer', off: true, short: false, name: '', note: data.off[key] };
  if (holiday) return { key, weekday, known: true, kind: 'holiday', off: true, short: false, name: holiday, note: '' };
  if (weekend) return { key, weekday, known: true, kind: 'weekend', off: true, short: false, name: '', note: '' };
  return { key, weekday, known: true, kind: 'work', off: false, short, name: '', note: short ? 'Сокращённый рабочий день (7 часов)' : '' };
}

/** Итоги месяца: рабочие и нерабочие дни, часы при 40-часовой неделе. */
export function monthStats(year, month) {
  if (!hasData(year)) return null;
  let work = 0, off = 0, short = 0;
  const total = daysInMonth(year, month);
  for (let day = 1; day <= total; day++) {
    const info = dayInfo(dateKey(year, month, day));
    if (info.off) off++; else { work++; if (info.short) short++; }
  }
  return { work, off, short, hours: work * 8 - short, total };
}

export function yearStats(year) {
  const sum = { work: 0, off: 0, short: 0, hours: 0, total: 0 };
  for (let month = 0; month < 12; month++) {
    const s = monthStats(year, month);
    if (!s) return null;
    for (const k of Object.keys(sum)) sum[k] += s[k];
  }
  return sum;
}

/** Особые дни месяца для списка под календарём. */
export function monthNotes(year, month) {
  const notes = [];
  for (let day = 1; day <= daysInMonth(year, month); day++) {
    const info = dayInfo(dateKey(year, month, day));
    const label = info.name || info.note;
    if (!info.known || !label) continue;
    // Выходные дни новогодних каникул схлопываем в одну строку.
    if (info.name === NEW_YEAR && notes.at(-1)?.name === NEW_YEAR) { notes.at(-1).to = day; continue; }
    notes.push({ day, to: day, name: info.name, text: label, kind: info.kind });
  }
  return notes;
}

/** Ближайший нерабочий праздничный или перенесённый день, начиная с даты (включительно). */
export function nextHoliday(fromKey) {
  const from = parseKey(fromKey);
  for (let i = 0; i < 400; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const info = dayInfo(keyOf(d));
    if (info.known && (info.kind === 'holiday' || info.kind === 'transfer')) {
      return { key: info.key, days: i, name: info.name || info.note, kind: info.kind };
    }
  }
  return null;
}
