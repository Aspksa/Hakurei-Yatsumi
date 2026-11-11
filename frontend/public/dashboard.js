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
  const now = new Date(), s = now.getSeconds();
  $('clockTime').innerHTML = `${pad(now.getHours())}<span class="colon">:</span>${pad(now.getMinutes())}<span class="sec"><span class="colon">:</span>${pad(s)}</span>`;
  const bar = $('clockBar');
  if (s === 0 || !bar.style.transform) { bar.style.transition = 'none'; bar.style.transform = `scaleX(${s / 60})`; void bar.offsetWidth; bar.style.transition = ''; }
  bar.style.transform = `scaleX(${(s + 1) / 60})`;
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
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const later = (ms, fn) => reduceMotion() ? fn() : setTimeout(fn, ms);
let tasks = [];
let taskFilter = 'active';
let dayFilter = null;
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
function taskItem(task, todayKey) {
  const li = document.createElement('li');
  li.className = 'task' + (task.done ? ' is-done' : '') + (task.id === fresh ? ' is-new' : '');
  li.dataset.id = task.id;
  const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(task.done), id: 'task-' + task.id });
  box.className = 'task-check';
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
    if (task.date) {
      const d = parseKey(task.date), late = !task.done && task.date < todayKey;
      const badge = Object.assign(document.createElement('time'), { textContent: `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`, dateTime: task.date });
      badge.className = 'task-date' + (late ? ' is-late' : task.date === todayKey && !task.done ? ' is-today' : '');
      badge.title = longDate(task.date) + (late ? ' — просрочено' : '');
      body.append(badge);
    }
  }
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  const edit = Object.assign(document.createElement('button'), { type: 'button', title: 'Изменить', ariaLabel: 'Изменить дело: ' + task.text });
  edit.className = 'task-edit';
  edit.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4"/></svg>';
  const del = Object.assign(document.createElement('button'), { type: 'button', title: 'Удалить', ariaLabel: 'Удалить дело: ' + task.text });
  del.className = 'task-del';
  del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  actions.append(edit, del);
  li.append(box, body, actions);
  return li;
}
function renderTasks() {
  const todayKey = today();
  const total = tasks.length, doneCount = tasks.filter(t => t.done).length, active = total - doneCount;
  const percent = total ? Math.round(doneCount / total * 100) : 0;
  $('tasksCount').textContent = !total ? '' : active ? `Осталось: ${active}` : 'Всё сделано';
  $('ringFg').style.strokeDashoffset = String(100 - percent);
  $('ringText').textContent = percent + '%';
  $('tasksRing').setAttribute('aria-label', `Выполнено ${percent}%`);
  $('tasksRing').classList.toggle('is-complete', total > 0 && !active);
  $('taskFilter').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === taskFilter)));
  $('dayFilter').hidden = !dayFilter;
  if (dayFilter) $('dayFilterText').textContent = `Дела на ${parseKey(dayFilter).getDate()} ${MONTHS_GENITIVE[parseKey(dayFilter).getMonth()]}`;
  const typed = $('taskDate').value;
  $('dateChips').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Boolean(typed) && typed === shiftKey(todayKey, Number(b.dataset.d)))));

  const visible = tasks.filter(t => (taskFilter === 'all' || (taskFilter === 'done') === Boolean(t.done)) && (!dayFilter || t.date === dayFilter));
  const byGroup = Object.fromEntries(GROUPS.map(([id]) => [id, []]));
  for (const t of visible) byGroup[groupOf(t, todayKey)].push(t);
  const nodes = [];
  for (const [id, title] of GROUPS) {
    const items = byGroup[id];
    if (!items.length) continue;
    items.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.created - b.created);
    if (!dayFilter) {
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
  $('taskEmptyText').textContent = dayFilter ? 'На этот день дел нет.' : taskFilter === 'done' ? 'Выполненных дел пока нет.' : total && taskFilter === 'active' ? 'Всё сделано. Отличная работа!' : 'Пока дел нет — добавьте первое.';
  $('taskClearDone').hidden = !doneCount;
}
$('taskForm').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('taskText').value.trim();
  if (!text) { $('taskText').focus(); return; }
  if (tasks.length >= 500) return;
  const task = { id: newId(), text, date: $('taskDate').value || null, done: false, created: Date.now() };
  tasks.push(task); fresh = task.id;
  saveTasks();
  $('taskText').value = '';
  $('taskDate').value = view.selected || '';
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
$('taskDate').addEventListener('change', renderTasks);
$('taskList').addEventListener('change', event => {
  const li = event.target.closest('.task'), task = tasks.find(t => t.id === li?.dataset.id);
  if (!task || !event.target.classList.contains('task-check')) return;
  task.done = event.target.checked;
  saveTasks();
  li.classList.toggle('is-done', task.done);
  if (task.done) li.classList.add('just-done');
  // Даём доиграть анимации галочки, затем перерисовываем (дело переезжает в другую группу или фильтр).
  later(task.done ? 480 : 200, () => { renderTasks(); renderCalendar(); });
});
$('taskList').addEventListener('click', event => {
  const li = event.target.closest('.task');
  if (!li) return;
  const id = li.dataset.id;
  if (event.target.closest('.task-del')) {
    li.classList.add('is-leaving');
    later(240, () => { tasks = tasks.filter(t => t.id !== id); saveTasks(); renderTasks(); renderCalendar(); });
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

// Подсветка карточек следом за курсором.
document.addEventListener('pointermove', event => {
  const card = event.target instanceof Element ? event.target.closest('.card') : null;
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty('--mx', event.clientX - rect.left + 'px');
  card.style.setProperty('--my', event.clientY - rect.top + 'px');
}, { passive: true });
