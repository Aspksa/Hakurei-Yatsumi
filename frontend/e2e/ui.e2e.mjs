// Браузерные проверки интерфейса. Запуск: npm run test:e2e
// (нужен Chromium: npx playwright install chromium). Бэкенд подменяется через page.route.
import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createGateway, readConfig } from '../server.js';

const config = { ...readConfig({ YATSUMI_API_KEY: 'e2e' }), apiKey: 'e2e' };
let server, browser, base;

before(async () => {
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); });
// Свежий шлюз на каждый тест: у шлюза есть лимит 120 запросов в минуту с одного адреса,
// а страница грузит десяток файлов, так что общий шлюз упёрся бы в лимит и отдавал 429.
beforeEach(async () => {
  const { app } = createGateway({ config, logger: () => {}, fetchImpl: async () => new Response('{}') });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function openPage({ connected = false, history = [], streamDelay = 0, storage = {}, viewport = { width: 1100, height: 800 }, time = null, avatar = true, avatarHidden = false } = {}) {
  const context = await browser.newContext({ viewport });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  const calls = [];
  if (avatarHidden) storage = { ...storage, 'yatsumi-avatar-prefs-v1': JSON.stringify({ show: false }) };
  await page.addInitScript(entries => { for (const [k, v] of Object.entries(entries)) if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, storage);
  await page.route('**/cloud/status', route => json(route, { configured: connected, connected, model: connected ? 'm' : undefined }));
  await page.route('**/cloud/models', route => json(route, { models: [{ id: 'm', name: 'Model' }] }));
  await page.route('**/core/history', route => json(route, { messages: history }));
  await page.route('**/cloud/chat/stream', async route => {
    calls.push(route.request().postDataJSON());
    if (streamDelay) await new Promise(resolve => setTimeout(resolve, streamDelay));
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"delta","content":"Ответ"}\n\ndata: {"type":"done"}\n\n' });
  });
  if (time) await page.clock.install({ time: new Date(time) });
  if (!avatar) await page.route('**/core/avatar*', route => route.fulfill({ status: 204 }));
  await page.goto(base + '/');
  if (avatarHidden) await page.locator('html[data-av="off"]').waitFor({ state: 'attached' });
  else if (avatar) await page.locator('#yatsumiAvatar').waitFor({ state: 'visible' });
  else await page.locator('html[data-no-avatar]').waitFor({ state: 'attached' });
  return { page, context, calls };
}
const openChat = page => page.click('#yatsumiAvatar');
const css = (page, selector, prop) => page.$eval(selector, (el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test('empty state guides setup and opens settings without a Memory section', async () => {
  const { page, context } = await openPage();
  await openChat(page);
  await page.locator('#emptyAction').click();
  assert.equal(await page.locator('#overlay').evaluate(d => d.open), true);
  assert.deepEqual(await page.locator('.tab').allTextContents(), ['Подключение', 'Главная', 'Аватар', 'Оформление']);
  assert.equal(await page.getByText('Память').count(), 0);
  await context.close();
});

test('preset theme applies, persists after reload and can be reset', async () => {
  const { page, context } = await openPage();
  await openChat(page); await page.click('#settingsOpen'); await page.click('#tab-look');
  await page.click('.preset[data-id="sakura"]');
  assert.equal((await css(page, 'html', '--gold')).trim(), '#e58fb0');
  assert.equal((await css(page, 'html', '--r-btn')).trim(), '10px');
  await page.reload();
  assert.equal((await css(page, 'html', '--gold')).trim(), '#e58fb0');
  await openChat(page); await page.click('#settingsOpen'); await page.click('#tab-look');
  assert.equal(await page.getAttribute('.preset[data-id="sakura"]', 'aria-pressed'), 'true');
  await page.click('#lookReset');
  assert.equal((await css(page, 'html', '--gold')).trim(), '#d4af37');
  await context.close();
});

test('straight shape removes rounding from buttons', async () => {
  const { page, context } = await openPage({ connected: true });
  await openChat(page); await page.click('#settingsOpen'); await page.click('#tab-look');
  await page.click('#shapeMode button[data-v="straight"]');
  await page.click('#settingsClose');
  assert.equal(await css(page, '#send', 'border-top-left-radius'), '0px');
  assert.equal(await css(page, '#chatPanel', 'border-top-left-radius'), '0px');
  await context.close();
});

test('message actions: copy, edit and retry', async () => {
  const { page, context, calls } = await openPage({ connected: true, history: [
    { role: 'user', content: 'Привет' }, { role: 'assistant', content: 'Здравствуй' }] });
  await openChat(page);
  assert.equal(await page.locator('.msg').count(), 2);
  await page.locator('.msg.assistant [data-act="copy"]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Здравствуй');
  await page.locator('.msg.user [data-act="edit"]').click();
  assert.equal(await page.inputValue('#message'), 'Привет');
  await page.fill('#message', '');
  await page.locator('.msg.assistant [data-act="retry"]').click();
  await page.locator('.msg').nth(3).waitFor();
  // Ждём конец ответа: пока идёт набор, кнопки под сообщением скрыты.
  await page.locator('.bubble.typing').waitFor({ state: 'detached' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, 'Привет');
  assert.equal(await page.locator('.msg').count(), 4);
  // Повторить остаётся только у последнего ответа.
  assert.equal(await page.locator('.msg.assistant [data-act="retry"]:visible').count(), 1);
  await context.close();
});

test('failed send removes the optimistic messages and keeps the text', async () => {
  const { page, context } = await openPage({ connected: true });
  await page.route('**/cloud/chat/stream', route => json(route, { error: 'Сбой' }, 500));
  await openChat(page);
  await page.fill('#message', 'Тест');
  await page.press('#message', 'Enter');
  await page.locator('#chatNotice').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.msg').count(), 0);
  assert.equal(await page.inputValue('#message'), 'Тест');
  await context.close();
});

async function drag(page, dx, dy) {
  const box = await page.locator('#yatsumiAvatar').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 }); await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
  return page.locator('#yatsumiAvatar').boundingBox();
}
const rightGap = (page, box) => page.evaluate(b => innerWidth - (b.x + b.width), box);

test('avatar snaps to the screen edge after dragging', async () => {
  const { page, context } = await openPage();
  let box = await drag(page, -30, -150);
  assert.ok(Math.abs(await rightGap(page, box) - 50) < 1.5, 'far from the edge: no snap');
  box = await drag(page, 25, 0);
  assert.ok(Math.abs(await rightGap(page, box) - 12) < 1.5, 'near the edge: snaps with a 12px margin');
  await context.close();
});

test('snap can be switched off', async () => {
  const { page, context } = await openPage({ storage: { 'yatsumi-avatar-prefs-v1': JSON.stringify({ snap: false }) } });
  let box = await drag(page, -30, -150);
  box = await drag(page, 25, 0);
  assert.ok(Math.abs(await rightGap(page, box) - 25) < 1.5, 'stays where dropped');
  await context.close();
});

test('avatar animation follows the setting and reacts while Yatsumi replies', async () => {
  const { page, context } = await openPage({ connected: true, streamDelay: 600 });
  assert.equal(await page.getAttribute('html', 'data-av-anim'), 'float');
  assert.equal(await css(page, '#yatsumiAvatar img', 'animation-name'), 'av-float');
  await openChat(page); await page.click('#settingsOpen'); await page.click('#tab-avatar');
  await page.click('#avAnim button[data-v="breathe"]');
  assert.equal(await css(page, '#yatsumiAvatar img', 'animation-name'), 'av-breathe');
  await page.click('#settingsClose');
  await page.fill('#message', 'Привет'); await page.press('#message', 'Enter');
  await page.waitForFunction(() => document.getElementById('yatsumiAvatar').classList.contains('is-busy'));
  assert.equal(await css(page, '#yatsumiAvatar img', 'animation-name'), 'av-think');
  await page.waitForFunction(() => !document.getElementById('yatsumiAvatar').classList.contains('is-busy'));
  await context.close();
});

test('mobile layout has no horizontal overflow', async () => {
  const { page, context } = await openPage({ viewport: { width: 390, height: 780 } });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'home');
  await page.fill('#taskText', 'Очень длинное название дела, которое должно переноситься на несколько строк без горизонтальной прокрутки'); await page.fill('#taskDate', '2026-11-20'); await page.click('#taskAdd');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'home with a long task');
  await openChat(page); await page.click('#settingsOpen'); await page.click('#tab-look');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.click('#tab-home');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'home tab');
  await context.close();
});

const NOW = '2026-11-04T10:15:30';

test('home: clock, date and today in the production calendar', async () => {
  const { page, context } = await openPage({ time: NOW });
  assert.match(await page.textContent('#clockTime'), /^10:15:\d\d$/);
  assert.equal(await page.textContent('#clockDate'), 'Среда, 4 ноября 2026');
  assert.equal(await page.textContent('#clockSub'), 'Сегодня: День народного единства');
  assert.equal(await page.textContent('#calMonth'), 'Ноябрь 2026');
  const today = page.locator('.cal-day.is-today');
  assert.equal(await today.getAttribute('data-key'), '2026-11-04');
  assert.match(await today.getAttribute('class'), /k-holiday/);
  const stat = k => page.textContent(`.stat[data-k="${k}"] b`);
  assert.deepEqual([await stat('work'), await stat('off'), await stat('hours')], ['20', '10', '159']);
  assert.match(await page.textContent('.year-line'), /2026 год: рабочих 247, выходных 118, норма 1972 ч/);
  await context.close();
});

test('home: the clock is an electronic seven-segment display', async () => {
  const { page, context } = await openPage({ time: NOW });
  assert.equal(await page.locator('#dial, #dialTicks, #handHour').count(), 0, 'no analog dial');
  assert.equal(await page.locator('#clockTime .dg').count(), 6);
  assert.equal(await page.locator('#clockTime .colon').count(), 2);
  const lit = i => page.locator('#clockTime .dg').nth(i).locator('.s.on').count();
  // 10:15 → цифры 1, 0, 1, 5: у «1» горят 2 сегмента, у «0» — 6, у «5» — 5.
  assert.deepEqual([await lit(0), await lit(1), await lit(2), await lit(3)], [2, 6, 2, 5]);
  assert.equal(await page.getAttribute('#clockTime .dg:nth-of-type(1)', 'data-d'), '1');
  // Двоеточие рисуется двумя светящимися точками, а не текстом.
  const dots = await page.$eval('#clockTime .colon', el => [getComputedStyle(el, '::before').width, getComputedStyle(el, '::after').width]);
  assert.ok(dots.every(w => parseFloat(w) > 2), `colon dots are visible: ${dots}`);
  // Секунды обновляются: цифры сегментов меняются, текст для скринридеров не расходится с ними.
  assert.match(await page.textContent('#clockTime'), /^10:15:\d\d$/);
  await context.close();
});

test('home: calendar days are rounded squares, not circles', async () => {
  const { page, context } = await openPage({ time: NOW });
  const radius = await page.$eval('.cal-day', el => getComputedStyle(el).borderTopLeftRadius);
  assert.equal(radius, '12px');
  const { width, height } = await page.$eval('.cal-day', el => el.getBoundingClientRect().toJSON());
  assert.ok(width > 0 && Math.abs(width - height) < width * 0.2, `roughly square: ${width}x${height}`);
  await context.close();
});

test('home: calendar shows ISO week numbers and weekly norm hours; month strip jumps to a month', async () => {
  const { page, context } = await openPage({ time: NOW });
  const rows = await page.locator('.cal-grid .wk:not(.cal-head)').allTextContents();
  assert.deepEqual(rows, ['44', '45', '46', '47', '48', '49']);
  // Неделя 2–8 ноября: пн 8 + вт 7 (сокращённый) + ср 0 (праздник) + чт 8 + пт 8 = 31 ч.
  assert.deepEqual(await page.locator('.cal-grid .wk-h:not(.cal-head)').allTextContents(), ['40', '31', '40', '40', '40', '40']);
  await page.click('#calMonths [data-month="2"]');
  assert.equal(await page.textContent('#calMonth'), 'Март 2026');
  assert.equal(await page.getAttribute('#calMonths [data-month="2"]', 'aria-pressed'), 'true');
  await context.close();
});

test('home: 2027 calendar shows the working Saturday, transfers and month norm', async () => {
  const { page, context } = await openPage({ time: NOW });
  await page.click('#calYear [data-year="2027"]');
  assert.equal(await page.textContent('#calMonth'), 'Ноябрь 2027');
  assert.match(await page.getAttribute('.cal-day[data-key="2027-11-05"]', 'class'), /k-transfer/);
  for (let i = 0; i < 9; i++) await page.click('#calPrev');
  assert.equal(await page.textContent('#calMonth'), 'Февраль 2027');
  const saturday = await page.getAttribute('.cal-day[data-key="2027-02-20"]', 'class');
  assert.match(saturday, /k-extra-work/);
  assert.match(saturday, /is-short/);
  assert.match(await page.getAttribute('.cal-day[data-key="2027-02-22"]', 'class'), /k-transfer/);
  const stat = k => page.textContent(`.stat[data-k="${k}"] b`);
  assert.deepEqual([await stat('work'), await stat('off'), await stat('hours')], ['19', '9', '151']);
  await page.click('#calToday');
  assert.equal(await page.textContent('#calMonth'), 'Ноябрь 2026');
  await context.close();
});

test('home: calendar days are reachable with the keyboard', async () => {
  const { page, context } = await openPage({ time: NOW });
  await page.locator('.cal-day.is-today').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.key), '2026-11-05');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.key), '2026-11-12');
  await page.keyboard.press('PageDown');
  assert.equal(await page.textContent('#calMonth'), 'Декабрь 2026');
  await context.close();
});

const taskCount = (page, n) => page.waitForFunction(count => document.querySelectorAll('.task').length === count, n);

test('home: tasks can be added, completed, deleted and survive a reload', async () => {
  const { page, context } = await openPage({ time: NOW, avatarHidden: true });
  await page.fill('#taskText', 'Купить хлеб'); await page.press('#taskText', 'Enter');
  await page.fill('#taskText', 'Оплатить интернет'); await page.fill('#taskDate', '2026-11-10'); await page.click('#taskAdd');
  await taskCount(page, 2);
  assert.equal(await page.inputValue('#taskDate'), '', 'the date does not stick to the next task');
  assert.equal(await page.textContent('#tasksCount'), 'Осталось: 2');
  assert.equal(await page.locator('.cal-day[data-key="2026-11-10"].has-tasks').count(), 1);
  await page.reload();
  await taskCount(page, 2);
  await page.locator('.task', { hasText: 'Купить хлеб' }).locator('input[type=checkbox]').click();
  await taskCount(page, 1); // выполненное уходит из «Активных» после короткой анимации
  assert.equal(await page.textContent('#ringText'), '50%');
  await page.click('#taskFilter [data-v="done"]');
  await taskCount(page, 1);
  assert.equal(await page.textContent('.task-text'), 'Купить хлеб');
  await page.click('#taskClearDone');
  await taskCount(page, 0);
  await page.click('#taskFilter [data-v="active"]');
  await page.locator('.task', { hasText: 'Оплатить интернет' }).locator('.task-del').click();
  await taskCount(page, 0);
  assert.equal(await page.isVisible('#taskEmpty'), true);
  assert.equal(await page.textContent('#ringText'), '0%');
  await context.close();
});

test('home: tasks are grouped by due date and quick date chips fill the date', async () => {
  const { page, context } = await openPage({ time: NOW, avatarHidden: true });
  await page.fill('#taskText', 'Просроченное'); await page.fill('#taskDate', '2026-11-01'); await page.click('#taskAdd');
  await page.fill('#taskText', 'На сегодня'); await page.click('#dateChips [data-d="0"]');
  assert.equal(await page.inputValue('#taskDate'), '2026-11-04');
  assert.equal(await page.getAttribute('#dateChips [data-d="0"]', 'aria-pressed'), 'true');
  await page.click('#taskAdd');
  await page.fill('#taskText', 'На завтра'); await page.click('#dateChips [data-d="1"]'); await page.click('#taskAdd');
  await page.fill('#taskText', 'Через неделю'); await page.click('#dateChips [data-d="7"]'); await page.click('#taskAdd');
  await page.fill('#taskText', 'Когда-нибудь'); await page.click('#taskAdd');
  await taskCount(page, 5);
  assert.deepEqual(await page.locator('.task-group span').allTextContents(), ['Просрочено', 'Сегодня', 'Завтра', 'Позже', 'Без срока']);
  assert.equal(await page.locator('.tile.is-late').count(), 1);
  assert.equal(await page.inputValue('#taskDate'), '', 'date is cleared after adding');
  await context.close();
});

test('home: priorities sort tasks first and tabs split today from upcoming', async () => {
  const { page, context } = await openPage({ time: NOW, avatarHidden: true });
  const add = async (text, chip, prio) => {
    await page.fill('#taskText', text);
    if (chip !== null) await page.click(`#dateChips [data-d="${chip}"]`);
    if (prio) await page.click(`#prioPick [data-p="${prio}"]`);
    await page.click('#taskAdd');
  };
  await add('Обычное', 0, 0);
  await add('Срочное', 0, 2);
  await add('Важное', 0, 1);
  await add('На завтра', 1, 0);
  await taskCount(page, 4);
  assert.deepEqual(await page.locator('.task-text').allTextContents(), ['Срочное', 'Важное', 'Обычное', 'На завтра']);
  assert.deepEqual(await page.locator('.tag').allTextContents(), ['Срочно', 'Важно']);
  assert.equal(await page.getAttribute('#prioPick [data-p="0"]', 'aria-pressed'), 'true', 'priority resets after adding');
  const counts = async () => page.locator('#taskFilter em').allTextContents();
  assert.deepEqual(await counts(), ['4', '3', '1', '0']);
  await page.click('#taskFilter [data-v="today"]');
  await taskCount(page, 3);
  await page.click('#taskFilter [data-v="soon"]');
  await taskCount(page, 1);
  assert.equal(await page.textContent('.task-text'), 'На завтра');
  await context.close();
});

test('home: a task can be edited in place', async () => {
  const { page, context } = await openPage({ time: NOW, avatarHidden: true });
  await page.fill('#taskText', 'Старый текст'); await page.press('#taskText', 'Enter');
  await page.hover('.task'); await page.click('.task-edit');
  await page.fill('.task-edit-input', 'Новый текст'); await page.press('.task-edit-input', 'Enter');
  assert.equal(await page.textContent('.task-text'), 'Новый текст');
  await page.click('.task-edit'); await page.fill('.task-edit-input', 'Не сохранять'); await page.press('.task-edit-input', 'Escape');
  assert.equal(await page.textContent('.task-text'), 'Новый текст');
  await page.reload(); await taskCount(page, 1);
  assert.equal(await page.textContent('.task-text'), 'Новый текст');
  await context.close();
});

test('home: a calendar day offers its own tasks', async () => {
  const { page, context } = await openPage({ time: NOW, avatarHidden: true });
  await page.fill('#taskText', 'День рождения'); await page.fill('#taskDate', '2026-11-20'); await page.click('#taskAdd');
  await page.fill('#taskText', 'Без даты'); await page.click('#taskAdd');
  await page.click('.cal-day[data-key="2026-11-20"]');
  assert.equal(await page.inputValue('#taskDate'), '2026-11-20');
  await page.getByRole('button', { name: 'Дела на этот день: 1' }).click();
  assert.equal(await page.locator('.task').count(), 1);
  assert.equal(await page.textContent('.task-text'), 'День рождения');
  await page.click('#dayFilterClear');
  await taskCount(page, 2);
  await context.close();
});

test('home widgets can be hidden from settings and the choice persists', async () => {
  const { page, context } = await openPage({ time: NOW });
  await openChat(page); await page.click('#settingsOpen'); await page.click('#tab-home');
  await page.uncheck('#dashCalendar'); await page.uncheck('#dashSeconds');
  await page.click('#settingsClose');
  assert.equal(await page.isVisible('#calendarCard'), false);
  assert.equal(await page.isVisible('#tasksCard'), true);
  assert.equal(await page.isVisible('.clock-time .sec'), false);
  await page.reload();
  assert.equal(await page.isVisible('#calendarCard'), false);
  await context.close();
});

test('without an avatar the chat opens from a launcher button and is closed by default', async () => {
  const { page, context } = await openPage({ avatar: false });
  assert.equal(await page.isVisible('#chatPanel'), false);
  assert.equal(await page.isVisible('#chatLauncher'), true);
  await page.click('#chatLauncher');
  assert.equal(await page.isVisible('#chatPanel'), true);
  await page.click('#chatClose');
  assert.equal(await page.isVisible('#chatPanel'), false);
  await context.close();
});

test('the floating avatar keeps clear of the bottom-right task controls until the chat opens', async () => {
  const { page, context } = await openPage({ time: NOW });
  const bottomGap = () => page.evaluate(() => innerHeight - document.getElementById('yatsumiAvatar').getBoundingClientRect().bottom);
  assert.ok(Math.abs(await bottomGap() - 20) < 8, 'sits near the corner while the chat is closed');
  await openChat(page);
  await page.waitForFunction(() => innerHeight - document.getElementById('yatsumiAvatar').getBoundingClientRect().bottom > 90);
  await context.close();
});
