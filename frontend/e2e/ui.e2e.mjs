// Браузерные проверки интерфейса. Запуск: npm run test:e2e
// (нужен Chromium: npx playwright install chromium). Бэкенд подменяется через page.route.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createGateway, readConfig } from '../server.js';

const config = { ...readConfig({ YATSUMI_API_KEY: 'e2e' }), apiKey: 'e2e' };
let server, browser, base;

before(async () => {
  const { app } = createGateway({ config, logger: () => {}, fetchImpl: async () => new Response('{}') });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function openPage({ connected = false, history = [], streamDelay = 0, storage = {}, viewport = { width: 1100, height: 800 } } = {}) {
  const context = await browser.newContext({ viewport });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  const calls = [];
  await page.addInitScript(entries => { for (const [k, v] of Object.entries(entries)) if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, storage);
  await page.route('**/cloud/status', route => json(route, { configured: connected, connected, model: connected ? 'm' : undefined }));
  await page.route('**/cloud/models', route => json(route, { models: [{ id: 'm', name: 'Model' }] }));
  await page.route('**/core/history', route => json(route, { messages: history }));
  await page.route('**/cloud/chat/stream', async route => {
    calls.push(route.request().postDataJSON());
    if (streamDelay) await new Promise(resolve => setTimeout(resolve, streamDelay));
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"delta","content":"Ответ"}\n\ndata: {"type":"done"}\n\n' });
  });
  await page.goto(base + '/');
  await page.locator('#yatsumiAvatar').waitFor({ state: 'visible' });
  return { page, context, calls };
}
const openChat = page => page.click('#yatsumiAvatar');
const css = (page, selector, prop) => page.$eval(selector, (el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test('empty state guides setup and opens settings without a Memory section', async () => {
  const { page, context } = await openPage();
  await openChat(page);
  await page.locator('#emptyAction').click();
  assert.equal(await page.locator('#overlay').evaluate(d => d.open), true);
  assert.deepEqual(await page.locator('.tab').allTextContents(), ['Подключение', 'Аватар', 'Оформление']);
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
  await openChat(page); await page.click('#settingsOpen'); await page.click('#tab-look');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await context.close();
});
