import { MONTHS, MONTHS_GENITIVE, WEEKDAYS, dateKey, keyOf, parseKey, daysInMonth, dayInfo, monthStats, yearStats, monthNotes, nextHoliday } from './production-calendar.js';

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const SHORT_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
const longDate = key => { const d = parseKey(key); return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_GENITIVE[d.getMonth()]} ${d.getFullYear()}`; };
const today = () => keyOf(new Date());
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const later = (ms, fn) => reduceMotion() ? fn() : setTimeout(fn, ms);
const isoWeek = date => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
};

/* ---------------- электронные часы (семисегментный дисплей) ---------------- */
const SEGMENTS = { a: 'M8 5 L13 0 L45 0 L50 5 L45 10 L13 10 Z', b: 'M53 8 L58 13 L58 44 L53 49 L48 44 L48 13 Z', c: 'M53 52 L58 57 L58 88 L53 93 L48 88 L48 57 Z',
  d: 'M8 95 L13 90 L45 90 L50 95 L45 100 L13 100 Z', e: 'M5 52 L10 57 L10 88 L5 93 L0 88 L0 57 Z', f: 'M5 8 L10 13 L10 44 L5 49 L0 44 L0 13 Z', g: 'M8 50 L13 45 L45 45 L50 50 L45 55 L13 55 Z' };
const LIT = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
const NS = 'http://www.w3.org/2000/svg';
const digitBox = $('clockTime');
const digits = [];
function makeDigit(parent) {
  const dg = document.createElement('span');
  dg.className = 'dg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 58 100'); svg.setAttribute('aria-hidden', 'true');
  for (const [name, path] of Object.entries(SEGMENTS)) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', path); p.setAttribute('class', 's'); p.dataset.s = name;
    svg.append(p);
  }
  const text = document.createElement('b');
  text.className = 'vh';
  dg.append(svg, text);
  parent.append(dg); digits.push(dg);
}
const colon = () => Object.assign(document.createElement('span'), { className: 'colon', textContent: ':' });
makeDigit(digitBox); makeDigit(digitBox); digitBox.append(colon()); makeDigit(digitBox); makeDigit(digitBox);
const secBox = Object.assign(document.createElement('span'), { className: 'sec' });
secBox.append(colon()); makeDigit(secBox); makeDigit(secBox); digitBox.append(secBox);
function setDigits(text) {
  digits.forEach((dg, i) => {
    const value = text[i];
    if (dg.dataset.d === value) return;
    dg.dataset.d = value;
    dg.querySelector('.vh').textContent = value;
    const lit = LIT[Number(value)];
    dg.querySelectorAll('.s').forEach(s => s.classList.toggle('on', lit.includes(s.dataset.s)));
  });
}

let clockDay = '';
function renderClock() {
  const now = new Date();
  setDigits(`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`);
  const elapsed = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const left = 86400 - elapsed;
  $('dayBar').style.transform = `scaleX(${elapsed / 86400})`;
  $('dayText').textContent = `День прошёл на ${Math.floor(elapsed / 864)}% · осталось ${Math.floor(left / 3600)} ч ${pad(Math.floor(left % 3600 / 60))} мин`;
  const key = keyOf(now);
  if (key !== clockDay) {
    clockDay = key;
    $('clockDate').textContent = longDate(key);
    const next = nextHoliday(key);
    $('clockSub').textContent = !next ? '' : next.days === 0 ? `Сегодня: ${next.name}`
      : `Ближайший выходной: ${parseKey(next.key).getDate()} ${MONTHS_GENITIVE[parseKey(next.key).getMonth()]} — через ${next.days} ${plural(next.days, 'день', 'дня', 'дней')}`;
    if (calendarReady && view.followToday) { view.year = now.getFullYear(); view.month = now.getMonth(); renderCalendar(); }
  }
}
function tick() {
  renderClock();
  setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
}

/* ---------------- дела ---------------- */
const TASKS_KEY = 'yatsumi-tasks-v1';
const PRIO = [null, 'Важно', 'Срочно'];
let tasks = [];
let taskFilter = 'active';
let dayFilter = null;
let newPrio = 0;
let fresh = null;   // id только что добавленного дела: для анимации появления
let editing = null; // id дела, которое сейчас редактируется
function loadTasks() {
  try {
    const list = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]');
    tasks = Array.isArray(list) ? list.filter(t => t && typeof t.id === 'string' && typeof t.text === 'string') : [];
  } catch { tasks = []; }
}
function saveTasks() { try { localStorage.setItem(TASKS_KEY, JSON.stringify(tasks)); } catch {} }
const newId = () => crypto.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2);
const activeOn = key => tasks.filter(t => !t.done && t.date === key).length;
const shiftKey = (key, days) => { const d = parseKey(key); return keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)); };
const GROUPS = [['late', 'Просрочено'], ['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['later', 'Позже'], ['none', 'Без срока'], ['done', 'Выполнено']];

function groupOf(task, todayKey) {
  if (task.done) return 'done';
  if (!task.date) return 'none';
  return task.date < todayKey ? 'late' : task.date === todayKey ? 'today' : task.date === shiftKey(todayKey, 1) ? 'tomorrow' : 'later';
}
function matches(task, filter, todayKey) {
  switch (filter) {
    case 'today': return !task.done && Boolean(task.date) && task.date <= todayKey;
    case 'soon': return !task.done && Boolean(task.date) && task.date > todayKey;
    case 'done': return Boolean(task.done);
    default: return !task.done;
  }
}
const icon = (path, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

function taskItem(task, todayKey) {
  const li = document.createElement('li');
  const late = !task.done && task.date && task.date < todayKey;
  li.className = 'task' + (task.done ? ' is-done' : '') + (task.id === fresh ? ' is-new' : '') + (task.prio ? ' p' + task.prio : '');
  li.dataset.id = task.id;

  const tile = document.createElement(task.date ? 'time' : 'div');
  tile.className = 'tile' + (!task.date ? ' is-none' : late ? ' is-late' : task.date === todayKey && !task.done ? ' is-today' : '');
  if (task.date) {
    const d = parseKey(task.date);
    tile.dateTime = task.date; tile.title = longDate(task.date) + (late ? ' — просрочено' : '');
    tile.innerHTML = '<b></b><span></span>';
    tile.firstChild.textContent = String(d.getDate()); tile.lastChild.textContent = SHORT_MONTHS[d.getMonth()];
  } else { tile.title = 'Без срока'; tile.innerHTML = icon('<path d="M5 12h14"/>', 18); }

  const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(task.done), id: 'task-' + task.id });
  box.className = 'task-check';
  box.setAttribute('aria-label', task.text);

  const body = document.createElement('div');
  body.className = 'task-body';
  if (task.id === editing) {
    const input = Object.assign(document.createElement('input'), { type: 'text', value: task.text, maxLength: 300 });
    input.className = 'task-edit-input'; input.setAttribute('aria-label', 'Изменить дело');
    body.append(input);
    queueMicrotask(() => { input.focus(); input.select(); });
  } else {
    const label = Object.assign(document.createElement('label'), { htmlFor: box.id, textContent: task.text });
    label.className = 'task-text';
    body.append(label);
    const tags = document.createElement('div');
    tags.className = 'task-tags';
    if (task.prio) tags.append(Object.assign(document.createElement('span'), { className: 'tag p' + task.prio, textContent: PRIO[task.prio] }));
    if (late) tags.append(Object.assign(document.createElement('span'), { className: 'tag late', textContent: 'просрочено' }));
    if (tags.childElementCount) body.append(tags);
  }

  const actions = document.createElement('div');
  actions.className = 'task-actions';
  const edit = Object.assign(document.createElement('button'), { type: 'button', title: 'Изменить', ariaLabel: 'Изменить дело: ' + task.text });
  edit.className = 'task-edit'; edit.innerHTML = icon('<path d="M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4"/>');
  const del = Object.assign(document.createElement('button'), { type: 'button', title: 'Удалить', ariaLabel: 'Удалить дело: ' + task.text });
  del.className = 'task-del'; del.innerHTML = icon('<path d="M6 6l12 12M18 6 6 18"/>');
  actions.append(edit, del);
  li.append(tile, body, actions, box);
  return li;
}
function renderTasks() {
  const todayKey = today();
  const total = tasks.length, doneCount = tasks.filter(t => t.done).length, active = total - doneCount;
  const percent = total ? Math.round(doneCount / total * 100) : 0;
  const lateCount = tasks.filter(t => !t.done && t.date && t.date < todayKey).length;
  $('tasksCount').textContent = !total ? '' : active ? `Осталось: ${active}` + (lateCount ? ` · просрочено: ${lateCount}` : '') : 'Всё сделано';
  $('ringFg').style.strokeDashoffset = String(100 - percent);
  $('ringText').textContent = percent + '%';
  $('tasksRing').setAttribute('aria-label', `Выполнено ${percent}%`);
  $('tasksRing').classList.toggle('is-complete', total > 0 && !active);
  $('taskFilter').querySelectorAll('button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.v === taskFilter));
    b.querySelector('em').textContent = String(tasks.filter(t => matches(t, b.dataset.v, todayKey)).length);
  });
  $('dayFilter').hidden = !dayFilter;
  if (dayFilter) $('dayFilterText').textContent = `Дела на ${parseKey(dayFilter).getDate()} ${MONTHS_GENITIVE[parseKey(dayFilter).getMonth()]}`;
  const typed = $('taskDate').value;
  $('dateChips').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Boolean(typed) && typed === shiftKey(todayKey, Number(b.dataset.d)))));
  $('prioPick').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.p) === newPrio)));

  const visible = tasks.filter(t => matches(t, taskFilter, todayKey) && (!dayFilter || t.date === dayFilter));
  const byGroup = Object.fromEntries(GROUPS.map(([id]) => [id, []]));
  for (const t of visible) byGroup[groupOf(t, todayKey)].push(t);
  const nodes = [];
  for (const [id, title] of GROUPS) {
    const items = byGroup[id];
    if (!items.length) continue;
    items.sort((a, b) => (b.prio || 0) - (a.prio || 0) || (a.date || '9999').localeCompare(b.date || '9999') || a.created - b.created);
    if (!dayFilter && taskFilter !== 'done') {
      const head = document.createElement('li');
      head.className = 'task-group g-' + id; head.setAttribute('role', 'presentation');
      head.innerHTML = '<span></span><b></b>';
      head.firstChild.textContent = title; head.lastChild.textContent = String(items.length);
      nodes.push(head);
    }
    for (const t of items) nodes.push(taskItem(t, todayKey));
  }
  $('taskList').replaceChildren(...nodes);
  fresh = null;
  const empty = $('taskEmpty');
  empty.hidden = visible.length > 0;
  $('taskEmptyText').textContent = dayFilter ? 'На этот день дел нет.'
    : taskFilter === 'done' ? 'Выполненных дел пока нет.'
    : taskFilter === 'today' ? 'На сегодня ничего не запланировано.'
    : taskFilter === 'soon' ? 'Предстоящих дел со сроком нет.'
    : total ? 'Всё сделано. Отличная работа!' : 'Пока дел нет — добавьте первое.';
  $('taskClearDone').hidden = !doneCount;
}
$('taskForm').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('taskText').value.trim();
  if (!text) { $('taskText').focus(); return; }
  if (tasks.length >= 500) return;
  const task = { id: newId(), text, date: $('taskDate').value || null, prio: newPrio, done: false, created: Date.now() };
  tasks.push(task); fresh = task.id;
  saveTasks();
  $('taskText').value = '';
  $('taskDate').value = view.selected || '';
  newPrio = 0;
  if (taskFilter === 'done') taskFilter = 'active';
  renderTasks(); renderCalendar();
  $('taskText').focus();
});
$('dateChips').addEventListener('click', event => {
  const b = event.target.closest('button');
  if (!b) return;
  const key = shiftKey(today(), Number(b.dataset.d));
  $('taskDate').value = $('taskDate').value === key ? '' : key;
  renderTasks();
});
$('prioPick').addEventListener('click', event => { const b = event.target.closest('button'); if (b) { newPrio = Number(b.dataset.p); renderTasks(); } });
$('taskDate').addEventListener('change', renderTasks);
$('taskList').addEventListener('change', event => {
  const li = event.target.closest('.task'), task = tasks.find(t => t.id === li?.dataset.id);
  if (!task || !event.target.classList.contains('task-check')) return;
  task.done = event.target.checked;
  saveTasks();
  li.classList.toggle('is-done', task.done);
  if (task.done) li.classList.add('just-done');
  // Даём доиграть анимации галочки, затем перерисовываем (дело переезжает в другую вкладку).
  later(task.done ? 520 : 200, () => { renderTasks(); renderCalendar(); });
});
$('taskList').addEventListener('click', event => {
  const li = event.target.closest('.task');
  if (!li) return;
  const id = li.dataset.id;
  if (event.target.closest('.task-del')) {
    li.classList.add('is-leaving');
    later(260, () => { tasks = tasks.filter(t => t.id !== id); saveTasks(); renderTasks(); renderCalendar(); });
  } else if (event.target.closest('.task-edit')) {
    editing = id; renderTasks();
  }
});
function finishEdit(input, save) {
  const id = input.closest('.task')?.dataset.id, task = tasks.find(t => t.id === id);
  editing = null;
  const text = input.value.trim();
  if (save && task && text) { task.text = text; saveTasks(); }
  renderTasks();
}
$('taskList').addEventListener('keydown', event => {
  if (!event.target.classList.contains('task-edit-input')) return;
  if (event.key === 'Enter') { event.preventDefault(); finishEdit(event.target, true); }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishEdit(event.target, false); }
});
$('taskList').addEventListener('focusout', event => {
  if (event.target.classList.contains('task-edit-input') && editing) finishEdit(event.target, true);
});
$('taskFilter').addEventListener('click', event => { const b = event.target.closest('button'); if (b) { taskFilter = b.dataset.v; renderTasks(); } });
$('dayFilterClear').addEventListener('click', () => { dayFilter = null; renderTasks(); renderCalendar(); });
$('taskClearDone').addEventListener('click', () => { tasks = tasks.filter(t => !t.done); saveTasks(); renderTasks(); renderCalendar(); });
window.addEventListener('storage', event => { if (event.key === TASKS_KEY) { loadTasks(); renderTasks(); renderCalendar(); } });

/* ---------------- календарь ---------------- */
const now0 = new Date();
const view = { year: now0.getFullYear(), month: now0.getMonth(), selected: null, cursor: null, followToday: true };
let calendarReady = false;

function describe(info) {
  if (!info.known) return info.kind === 'weekend' ? 'Выходной день (по сетке; календарь на этот год не загружен)' : 'Рабочий день по сетке (календарь на этот год не загружен)';
  switch (info.kind) {
    case 'holiday': return 'Праздничный день: ' + info.name + (info.weekday === 0 || info.weekday === 6 ? ' (выходной день перенесён)' : '');
    case 'transfer': return info.note;
    case 'weekend': return 'Выходной день';
    case 'extra-work': return info.note + (info.short ? '; сокращённый день, 7 часов' : '');
    default: return 'Рабочий день' + (info.short ? ', сокращённый: 7 часов' : '');
  }
}
const div = (className, text) => Object.assign(document.createElement('div'), { className, textContent: text ?? '' });

function renderMonths() {
  const box = $('calMonths');
  box.replaceChildren(...MONTHS.map((name, month) => {
    const stats = monthStats(view.year, month);
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.month = String(month);
    b.setAttribute('aria-pressed', String(month === view.month));
    if (view.year === now0.getFullYear() && month === now0.getMonth()) b.classList.add('is-current');
    b.title = stats ? `${name} ${view.year}: ${stats.work} раб. дн., ${stats.hours} ч` : `${name} ${view.year}`;
    b.innerHTML = '<span></span><i></i>';
    b.firstChild.textContent = name.slice(0, 3).toLowerCase();
    b.lastChild.style.setProperty('--h', stats ? String(Math.round((stats.work - 14) / 9 * 100)) + '%' : '30%');
    return b;
  }));
}

function renderCalendar() {
  const { year, month } = view;
  $('calMonth').textContent = `${MONTHS[month]} ${year}`;
  $('calYear').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.year) === year)));
  renderMonths();
  const first = new Date(year, month, 1), offset = (first.getDay() + 6) % 7, total = daysInMonth(year, month);
  const weeks = Math.ceil((offset + total) / 7), todayKey = today();
  const cursor = view.cursor || view.selected || (todayKey.startsWith(`${year}-${pad(month + 1)}`) ? todayKey : dateKey(year, month, 1));
  const cells = [div('cal-head wk', '№'), ...['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((name, i) => div('cal-head' + (i > 4 ? ' is-weekend' : ''), name)), div('cal-head wk-h', 'ч')];
  cells.forEach(cell => cell.setAttribute('aria-hidden', 'true'));
  for (let week = 0; week < weeks; week++) {
    const monday = new Date(year, month, 1 - offset + week * 7);
    let hours = 0, known = true;
    const row = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i), key = keyOf(date), info = dayInfo(key);
      known = known && info.known;
      if (!info.off) hours += 8 - (info.short ? 1 : 0);
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.key = key;
      button.className = ['cal-day', 'k-' + info.kind, info.short && 'is-short', key === todayKey && 'is-today', key === view.selected && 'is-selected',
        date.getMonth() !== month && 'is-other', activeOn(key) && 'has-tasks'].filter(Boolean).join(' ');
      const n = activeOn(key);
      button.innerHTML = '<span class="n"></span><span class="dots"></span>';
      button.firstChild.textContent = String(date.getDate());
      button.lastChild.replaceChildren(...Array.from({ length: Math.min(n, 3) }, () => document.createElement('i')));
      button.title = describe(info);
      button.setAttribute('aria-label', `${longDate(key)}. ${describe(info)}${n ? `. Дел: ${n}` : ''}`);
      button.tabIndex = key === cursor ? 0 : -1;
      if (key === todayKey) button.setAttribute('aria-current', 'date');
      button.setAttribute('aria-pressed', String(key === view.selected));
      row.push(button);
    }
    const wk = div('wk', String(isoWeek(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3))));
    wk.title = 'Номер недели'; wk.setAttribute('aria-hidden', 'true');
    const wh = div('wk-h' + (known && hours < 40 ? ' is-short' : ''), known ? String(hours) : '');
    wh.title = known ? `Норма недели: ${hours} ч` : ''; wh.setAttribute('aria-hidden', 'true');
    cells.push(wk, ...row, wh);
  }
  $('calGrid').replaceChildren(...cells);

  const stats = monthStats(year, month), ys = yearStats(year), box = $('calStats');
  box.replaceChildren();
  if (stats) {
    for (const [k, value, label] of [['work', stats.work, 'рабочих дней'], ['off', stats.off, 'выходных и праздничных'], ['hours', stats.hours, 'часов по норме']]) {
      const tile = div('stat'); tile.dataset.k = k;
      tile.innerHTML = '<b></b><span></span>'; tile.firstChild.textContent = String(value); tile.lastChild.textContent = label;
      box.append(tile);
    }
    box.append(Object.assign(document.createElement('p'), { className: 'year-line', textContent: `${year} год: рабочих ${ys.work}, выходных ${ys.off}, норма ${ys.hours} ч (40-часовая неделя)` }));
  } else box.append(Object.assign(document.createElement('p'), { className: 'year-line', textContent: `Для ${year} года производственный календарь не загружен: показаны только выходные по сетке.` }));

  $('calNotes').replaceChildren(...monthNotes(year, month).map(n => {
    const li = document.createElement('li');
    li.className = 'k-' + n.kind;
    li.textContent = `${n.to !== n.day ? `${n.day}–${n.to}` : n.day} ${MONTHS_GENITIVE[month]} — ${n.text}`;
    return li;
  }));
  renderDetail();
}

function renderDetail() {
  const key = view.selected || today(), d = parseKey(key), box = $('calDetail'), n = activeOn(key);
  box.replaceChildren();
  const num = div('dd-num'); num.innerHTML = '<b></b><span></span>';
  num.firstChild.textContent = String(d.getDate()); num.lastChild.textContent = SHORT_MONTHS[d.getMonth()];
  const text = div('dd-text');
  const title = Object.assign(document.createElement('strong'), { textContent: longDate(key) });
  text.append(title, document.createElement('br'), document.createTextNode(describe(dayInfo(key))));
  if (n) {
    const show = Object.assign(document.createElement('button'), { type: 'button', textContent: `Дела на этот день: ${n}` });
    show.className = 'link-button';
    show.addEventListener('click', () => { dayFilter = key; taskFilter = 'active'; renderTasks(); $('tasksCard').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    text.append(document.createElement('br'), show);
  }
  box.append(num, text);
}

function go(year, month) {
  const d = new Date(year, month, 1), forward = d > new Date(view.year, view.month, 1);
  view.year = d.getFullYear(); view.month = d.getMonth(); view.cursor = null;
  view.followToday = view.year === now0.getFullYear() && view.month === now0.getMonth();
  renderCalendar();
  const grid = $('calGrid');
  grid.classList.remove('slide-next', 'slide-prev');
  void grid.offsetWidth;
  grid.classList.add(forward ? 'slide-next' : 'slide-prev');
}
function select(key) {
  view.selected = key; view.cursor = key;
  const d = parseKey(key);
  view.year = d.getFullYear(); view.month = d.getMonth();
  view.followToday = false;
  $('taskDate').value = key;
  renderCalendar(); renderTasks();
  $('calGrid').querySelector(`[data-key="${key}"]`)?.focus();
}
$('calPrev').addEventListener('click', () => go(view.year, view.month - 1));
$('calNext').addEventListener('click', () => go(view.year, view.month + 1));
$('calToday').addEventListener('click', () => { view.selected = null; go(new Date().getFullYear(), new Date().getMonth()); view.followToday = true; });
$('calYear').addEventListener('click', event => { const b = event.target.closest('button'); if (b) go(Number(b.dataset.year), view.month); });
$('calMonths').addEventListener('click', event => { const b = event.target.closest('button'); if (b) go(view.year, Number(b.dataset.month)); });
$('calGrid').addEventListener('click', event => { const b = event.target.closest('.cal-day'); if (b) select(b.dataset.key); });
$('calGrid').addEventListener('keydown', event => {
  const b = event.target.closest('.cal-day');
  if (!b) return;
  const d = parseKey(b.dataset.key);
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
  let target;
  if (step) target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step);
  else if (event.key === 'PageUp') target = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  else if (event.key === 'PageDown') target = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  else if (event.key === 'Home') target = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  else if (event.key === 'End') target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (6 - ((d.getDay() + 6) % 7)));
  else return;
  event.preventDefault();
  const key = keyOf(target);
  view.cursor = key; view.year = target.getFullYear(); view.month = target.getMonth();
  view.followToday = false;
  renderCalendar();
  $('calGrid').querySelector(`[data-key="${key}"]`)?.focus();
});

loadTasks();
calendarReady = true;
renderCalendar();
renderTasks();
tick();
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderClock(); });

// Подсветка карточек следом за курсором.
document.addEventListener('pointermove', event => {
  const card = event.target instanceof Element ? event.target.closest('.card') : null;
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty('--mx', event.clientX - rect.left + 'px');
  card.style.setProperty('--my', event.clientY - rect.top + 'px');
}, { passive: true });
