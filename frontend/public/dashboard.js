import { MONTHS, MONTHS_GENITIVE, WEEKDAYS, dateKey, keyOf, parseKey, daysInMonth, hasData, dayInfo, monthStats, yearStats, monthNotes, nextHoliday } from './production-calendar.js';

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const SHORT_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
const longDate = key => { const d = parseKey(key); return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_GENITIVE[d.getMonth()]} ${d.getFullYear()}`; };
const today = () => keyOf(new Date());

/* ---------------- часы ---------------- */
let clockDay = '';
function renderClock() {
  const now = new Date();
  $('clockTime').innerHTML = `${pad(now.getHours())}:${pad(now.getMinutes())}<span class="sec">:${pad(now.getSeconds())}</span>`;
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

/* ---------------- задачи ---------------- */
const TASKS_KEY = 'yatsumi-tasks-v1';
let tasks = [];
let taskFilter = 'active';
let dayFilter = null;
function loadTasks() {
  try {
    const list = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]');
    tasks = Array.isArray(list) ? list.filter(t => t && typeof t.id === 'string' && typeof t.text === 'string') : [];
  } catch { tasks = []; }
}
function saveTasks() { try { localStorage.setItem(TASKS_KEY, JSON.stringify(tasks)); } catch {} }
const newId = () => crypto.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2);
const activeOn = key => tasks.filter(t => !t.done && t.date === key).length;

function renderTasks() {
  const todayKey = today();
  const active = tasks.filter(t => !t.done).length;
  $('tasksCount').textContent = !tasks.length ? '' : active ? `Осталось: ${active}` : 'Всё сделано';
  $('taskFilter').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === taskFilter)));
  $('dayFilter').hidden = !dayFilter;
  if (dayFilter) $('dayFilterText').textContent = `Дела на ${parseKey(dayFilter).getDate()} ${MONTHS_GENITIVE[parseKey(dayFilter).getMonth()]}`;
  const visible = tasks.filter(t => (taskFilter === 'all' || (taskFilter === 'done') === Boolean(t.done)) && (!dayFilter || t.date === dayFilter));
  visible.sort((a, b) => (a.done - b.done) || (a.date || '9999').localeCompare(b.date || '9999') || a.created - b.created);
  const list = $('taskList');
  list.replaceChildren(...visible.map(task => {
    const li = document.createElement('li');
    li.className = 'task' + (task.done ? ' is-done' : '');
    li.dataset.id = task.id;
    const label = document.createElement('label');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(task.done) });
    const text = Object.assign(document.createElement('span'), { textContent: task.text });
    text.className = 'task-text';
    label.append(box, text);
    li.append(label);
    if (task.date) {
      const d = parseKey(task.date);
      const badge = Object.assign(document.createElement('time'), { textContent: `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`, dateTime: task.date });
      badge.className = 'task-date' + (!task.done && task.date < todayKey ? ' is-late' : task.date === todayKey ? ' is-today' : '');
      badge.title = longDate(task.date) + (!task.done && task.date < todayKey ? ' — просрочено' : '');
      li.append(badge);
    }
    const del = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', title: 'Удалить', ariaLabel: 'Удалить дело: ' + task.text });
    del.className = 'task-del';
    li.append(del);
    return li;
  }));
  const empty = $('taskEmpty');
  empty.hidden = visible.length > 0;
  empty.textContent = dayFilter ? 'На этот день дел нет.' : taskFilter === 'done' ? 'Выполненных дел нет.' : tasks.length && taskFilter === 'active' ? 'Всё сделано. Отличная работа!' : 'Пока дел нет — добавьте первое.';
  $('taskClearDone').hidden = !tasks.some(t => t.done);
}
$('taskForm').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('taskText').value.trim();
  if (!text) { $('taskText').focus(); return; }
  if (tasks.length >= 500) return;
  tasks.push({ id: newId(), text, date: $('taskDate').value || null, done: false, created: Date.now() });
  saveTasks();
  $('taskText').value = '';
  $('taskDate').value = view.selected || '';
  if (taskFilter === 'done') taskFilter = 'active';
  renderTasks(); renderCalendar();
  $('taskText').focus();
});
$('taskList').addEventListener('change', event => {
  const id = event.target.closest('.task')?.dataset.id, task = tasks.find(t => t.id === id);
  if (!task || event.target.type !== 'checkbox') return;
  task.done = event.target.checked;
  saveTasks(); renderTasks(); renderCalendar();
});
$('taskList').addEventListener('click', event => {
  if (!event.target.closest('.task-del')) return;
  const id = event.target.closest('.task').dataset.id;
  tasks = tasks.filter(t => t.id !== id);
  saveTasks(); renderTasks(); renderCalendar();
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

function renderCalendar() {
  const { year, month } = view;
  $('calMonth').textContent = `${MONTHS[month]} ${year}`;
  $('calYear').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.year) === year)));
  const first = new Date(year, month, 1), offset = (first.getDay() + 6) % 7, total = daysInMonth(year, month);
  const weeks = Math.ceil((offset + total) / 7), todayKey = today();
  const cursor = view.cursor || view.selected || (todayKey.startsWith(`${year}-${pad(month + 1)}`) ? todayKey : dateKey(year, month, 1));
  const cells = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((name, i) => {
    const head = Object.assign(document.createElement('div'), { textContent: name });
    head.className = 'cal-head' + (i > 4 ? ' is-weekend' : ''); head.setAttribute('aria-hidden', 'true');
    return head;
  });
  for (let i = 0; i < weeks * 7; i++) {
    const date = new Date(year, month, 1 - offset + i), key = keyOf(date), info = dayInfo(key);
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.key = key;
    button.className = ['cal-day', 'k-' + info.kind, info.short && 'is-short', key === todayKey && 'is-today', key === view.selected && 'is-selected',
      date.getMonth() !== month && 'is-other', activeOn(key) && 'has-tasks'].filter(Boolean).join(' ');
    button.textContent = String(date.getDate());
    button.title = describe(info) + (info.short && info.kind === 'holiday' ? '' : '');
    button.setAttribute('aria-label', `${longDate(key)}. ${describe(info)}${activeOn(key) ? `. Дел: ${activeOn(key)}` : ''}`);
    button.tabIndex = key === cursor ? 0 : -1;
    if (key === todayKey) button.setAttribute('aria-current', 'date');
    button.setAttribute('aria-pressed', String(key === view.selected));
    cells.push(button);
  }
  $('calGrid').replaceChildren(...cells);

  const stats = monthStats(year, month), ys = yearStats(year);
  $('calStats').innerHTML = '';
  if (stats) {
    const line = (text) => { const p = document.createElement('div'); p.textContent = text; $('calStats').append(p); };
    line(`${MONTHS[month]}: рабочих дней ${stats.work}, выходных и праздничных ${stats.off}, норма ${stats.hours} ч`);
    line(`${year} год: рабочих ${ys.work}, выходных ${ys.off}, норма ${ys.hours} ч (40-часовая неделя)`);
  } else $('calStats').textContent = `Для ${year} года производственный календарь не загружен: показаны только выходные по сетке.`;

  const notes = monthNotes(year, month);
  $('calNotes').replaceChildren(...notes.map(n => {
    const li = document.createElement('li');
    li.className = 'k-' + n.kind;
    const range = n.to !== n.day ? `${n.day}–${n.to}` : String(n.day);
    li.textContent = `${range} ${MONTHS_GENITIVE[month]} — ${n.text}`;
    return li;
  }));
  renderDetail();
}

function renderDetail() {
  const key = view.selected || today();
  const box = $('calDetail');
  box.replaceChildren();
  const title = Object.assign(document.createElement('strong'), { textContent: longDate(key) });
  const text = document.createElement('span');
  text.textContent = describe(dayInfo(key));
  box.append(title, document.createTextNode(' — '), text);
  const n = activeOn(key);
  if (n) {
    const show = Object.assign(document.createElement('button'), { type: 'button', textContent: `Дела на этот день: ${n}` });
    show.className = 'link-button';
    show.addEventListener('click', () => { dayFilter = key; taskFilter = 'active'; renderTasks(); $('tasksCard').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    box.append(document.createElement('br'), show);
  }
}

function go(year, month) {
  const d = new Date(year, month, 1);
  view.year = d.getFullYear(); view.month = d.getMonth(); view.cursor = null;
  view.followToday = view.year === now0.getFullYear() && view.month === now0.getMonth();
  renderCalendar();
}
function select(key) {
  view.selected = key; view.cursor = key;
  const d = parseKey(key);
  view.year = d.getFullYear(); view.month = d.getMonth();
  view.followToday = false;
  $('taskDate').value = key;
  renderCalendar();
  $('calGrid').querySelector(`[data-key="${key}"]`)?.focus();
}
$('calPrev').addEventListener('click', () => go(view.year, view.month - 1));
$('calNext').addEventListener('click', () => go(view.year, view.month + 1));
$('calToday').addEventListener('click', () => { view.selected = null; go(new Date().getFullYear(), new Date().getMonth()); view.followToday = true; });
$('calYear').addEventListener('click', event => { const b = event.target.closest('button'); if (b) go(Number(b.dataset.year), view.month); });
$('calGrid').addEventListener('click', event => { const b = event.target.closest('.cal-day'); if (b) select(b.dataset.key); });
$('calGrid').addEventListener('keydown', event => {
  const b = event.target.closest('.cal-day');
  if (!b) return;
  const d = parseKey(b.dataset.key);
  const step = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [0, -7], ArrowDown: [0, 7] }[event.key];
  let target;
  if (step) target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step[1]);
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
