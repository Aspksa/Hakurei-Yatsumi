const $ = id => document.getElementById(id);
const overlay = $('overlay');
const conversation = $('conversation');
const message = $('message');
const modelSelect = $('modelSelect');
let cloudState = { configured: false, connected: false };
let starting = true;
let sending = false;
let configuring = false;
let pendingRetry = null;

function updateControls() {
  const busy = starting || sending || configuring;
  $('send').disabled = busy || !cloudState.connected;
  $('saveKey').disabled = busy;
  $('forgetKey').disabled = busy || !cloudState.configured;
  $('reloadModels').disabled = busy || !cloudState.configured;
  modelSelect.disabled = busy || modelSelect.options.length < 2;
  $('connectModel').disabled = modelSelect.disabled || !modelSelect.value;
  for (const b of conversation.querySelectorAll('[data-act="retry"]')) b.disabled = busy || !cloudState.connected;
  conversation.classList.toggle('is-busy', sending);
  $('yatsumiAvatar').classList.toggle('is-busy', sending);
}
function setStatus(state) {
  cloudState = state;
  const label = state.connected ? 'Модель работает' : state.configured ? 'Не подключено' : 'Нет подключения';
  for (const id of ['headerDot', 'panelDot']) $(id).className = 'dot ' + (state.connected ? 'green' : 'red');
  $('headerStatus').textContent = label;
  $('panelStatus').textContent = label;
  const usage = state.usage ?? {};
  $('tokenUsage').textContent = 'Токены: ' + (usage.total_tokens || 0) + ' · вход ' + (usage.prompt_tokens || 0) + ' · выход ' + (usage.completion_tokens || 0);
  $('emptyTitle').textContent = state.connected ? 'Привет! Я Яцуми' : 'Яцуми ждёт подключения';
  $('emptyText').textContent = state.connected ? 'Напишите первое сообщение — я отвечу и запомню важное.' : 'Добавьте API-ключ Cloud.ru и выберите модель — это займёт минуту.';
  $('emptyAction').hidden = state.connected;
  message.placeholder = state.connected ? 'Напиши сообщение Яцуми…' : 'Сначала подключите модель…';
  updateControls();
}
function notice(text) { $('notice').textContent = text; }
function chatNotice(text) {
  $('chatNotice').textContent = text;
  $('chatNotice').hidden = !text;
}
const chatPanel = $('chatPanel');
function setChatOpen(open) {
  chatPanel.classList.toggle('is-open', open);
  $('yatsumiAvatar').setAttribute('aria-expanded', String(open));
  if (open) { scrollToLatest(); message.focus(); }
}
function openSettings() {
  if (!overlay.open) overlay.showModal();
}
function closeSettings() { overlay.close(); }

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: options.body ? { 'content-type': 'application/json' } : {} });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Ошибка подключения: HTTP ' + response.status);
  return result;
}
async function refreshStatus() {
  try { setStatus(await api('/cloud/status')); } catch {}
}
function preferredModel() {
  try { return localStorage.getItem('yatsumi-cloud-model'); } catch { return null; }
}
async function refreshModels(preferred = modelSelect.value || cloudState.model || preferredModel()) {
  modelSelect.replaceChildren(new Option('Загрузка моделей…', ''));
  try {
    const { models } = await api('/cloud/models');
    modelSelect.replaceChildren(new Option('Выберите модель', ''), ...models.map(model => new Option(model.name, model.id)));
    if (models.some(model => model.id === preferred)) modelSelect.value = preferred;
    $('modelCount').textContent = 'Доступно моделей: ' + models.length;
    notice(models.length ? 'Выберите модель и нажмите «Подключить модель».' : 'Cloud.ru вернул пустой список моделей.');
  } catch (error) {
    modelSelect.replaceChildren(new Option('Не удалось загрузить модели', ''));
    $('modelCount').textContent = 'Ошибка загрузки';
    throw error;
  }
}
async function configure(work) {
  if (starting || sending || configuring) return;
  configuring = true;
  updateControls();
  try { await work(); }
  catch (error) { notice(error.message); await refreshStatus(); }
  finally { configuring = false; updateControls(); }
}
$('settingsOpen').addEventListener('click', openSettings);
$('emptyAction').addEventListener('click', openSettings);
$('statusButton').addEventListener('click', openSettings);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !overlay.open && chatPanel.classList.contains('is-open')) { setChatOpen(false); $('yatsumiAvatar').focus(); }
});
$('settingsClose').addEventListener('click', closeSettings);
$('chatClose').addEventListener('click', () => { setChatOpen(false); $('yatsumiAvatar').focus(); });
$('settingsCloseBackdrop').addEventListener('click', closeSettings);
$('toggleKey').addEventListener('click', () => {
  const visible = $('apiKey').type === 'password';
  $('apiKey').type = visible ? 'text' : 'password';
  $('toggleKey').setAttribute('aria-label', visible ? 'Скрыть ключ' : 'Показать ключ');
});
$('saveKey').addEventListener('click', () => configure(async () => {
  const key = $('apiKey').value.trim();
  if (!key) return notice('Вставьте API-ключ Cloud.ru.');
  setStatus(await api('/cloud/key', { method: 'POST', body: JSON.stringify({ key }) }));
  $('apiKey').value = '';
  notice('Ключ принят. Загружаю модели…');
  await refreshModels(preferredModel());
}));
$('reloadModels').addEventListener('click', () => configure(() => refreshModels()));
modelSelect.addEventListener('change', updateControls);
$('connectModel').addEventListener('click', () => configure(async () => {
  const model = modelSelect.value;
  notice('Проверяю подключение к модели…');
  const state = await api('/cloud/connect', { method: 'POST', body: JSON.stringify({ model }) });
  setStatus(state);
  try { localStorage.setItem('yatsumi-cloud-model', state.model || ''); } catch {}
  notice('Модель подключена. Можно начать диалог.');
  if (overlay.open) closeSettings();
  setChatOpen(true);
}));
$('forgetKey').addEventListener('click', () => configure(async () => {
  setStatus(await api('/cloud/key', { method: 'DELETE' }));
  modelSelect.replaceChildren(new Option('Нужен API-ключ', ''));
  $('modelCount').textContent = 'Модели ещё не загружены';
  try { localStorage.removeItem('yatsumi-cloud-model'); } catch {}
  notice('Ключ сброшен.');
}));
function bubble(role, content) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const element = document.createElement('div');
  element.className = 'bubble ' + role;
  element.textContent = content;
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const add = (act, label, title) => {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.act = act; button.textContent = label; button.title = title;
    actions.append(button);
  };
  add('copy', 'Копировать', 'Скопировать текст сообщения');
  if (role === 'user') add('edit', 'Изменить', 'Вставить в поле ввода, чтобы поправить и отправить заново');
  else add('retry', 'Повторить', 'Отправить предыдущее сообщение ещё раз');
  wrap.append(element, actions);
  conversation.append(wrap);
  return element;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const area = Object.assign(document.createElement('textarea'), { value: text });
  area.style.cssText = 'position:fixed;opacity:0';
  document.body.append(area); area.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
}
conversation.addEventListener('click', async event => {
  const button = event.target.closest('.msg-actions button');
  if (!button || button.disabled) return;
  const wrap = button.closest('.msg');
  const text = wrap.querySelector('.bubble').textContent;
  if (button.dataset.act === 'copy') {
    const label = button.textContent;
    button.textContent = (await copyText(text)) ? 'Скопировано' : 'Не удалось';
    setTimeout(() => { button.textContent = label; }, 1500);
  } else if (button.dataset.act === 'edit') {
    message.value = text; message.focus();
  } else if (button.dataset.act === 'retry') {
    const previous = wrap.previousElementSibling;
    if (!previous?.classList.contains('user')) return;
    message.value = previous.querySelector('.bubble').textContent;
    $('chatForm').requestSubmit();
  }
});
function scrollToLatest() { conversation.scrollTop = conversation.scrollHeight; }
function nearLatest() { return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48; }

async function streamReply(content, requestId, loading) {
  const response = await fetch('/cloud/chat/stream', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: content, requestId })
  });
  if (!response.ok || !response.body) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || 'Ответ недоступен: HTTP ' + response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', answer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Соединение оборвалось до завершения ответа');
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop();
      for (const part of parts) {
        const data = part.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === 'error') throw new Error(event.error);
        if (event.type === 'delta') {
          const follow = nearLatest();
          answer += event.content;
          loading.classList.remove('typing');
          loading.textContent = answer;
          if (follow) scrollToLatest();
        }
        if (event.type === 'done') return;
      }
    }
  } finally { void reader.cancel().catch(() => {}); }
}
$('chatForm').addEventListener('submit', async event => {
  event.preventDefault();
  const content = message.value.trim();
  if (!content || starting || sending || configuring || !cloudState.connected) return;

  const requestId = pendingRetry?.content === content ? pendingRetry.requestId : crypto.randomUUID();
  pendingRetry = { content, requestId };
  sending = true;
  updateControls();
  chatNotice('');
  message.value = '';
  const userBubble = bubble('user', content);
  const loading = bubble('assistant', '');
  loading.classList.add('typing');
  loading.setAttribute('aria-label', 'Яцуми думает');
  loading.append(...[0, 1, 2].map(() => document.createElement('i')));
  scrollToLatest();

  try {
    await streamReply(content, requestId, loading);
    pendingRetry = null;
  } catch (error) {
    userBubble.parentElement.remove();
    loading.parentElement.remove();
    if (!message.value) message.value = content;
    chatNotice('Ошибка: ' + error.message);
  } finally {
    await refreshStatus();
    sending = false;
    updateControls();
  }
});
message.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    $('chatForm').requestSubmit();
  }
});
(async () => {
  updateControls();
  const [state, saved] = await Promise.allSettled([api('/cloud/status'), api('/core/history')]);
  if (state.status === 'fulfilled') setStatus(state.value);
  else chatNotice('Локальный шлюз недоступен. Обновите страницу после запуска приложения.');
  if (saved.status === 'fulfilled') {
    const messages = saved.value.messages.filter(item => ['user', 'assistant'].includes(item.role));
    if (messages.length) {
      for (const item of messages) bubble(item.role, item.content);
      scrollToLatest();
    }
  } else if (state.status === 'fulfilled') {
    chatNotice('Не удалось загрузить историю. Проверьте, запущена ли служба SQLite.');
  }
  starting = false;
  updateControls();
  if (cloudState.configured) await configure(() => refreshModels());
})();

const avatar = $('yatsumiAvatar');
const positionKey = 'yatsumi-avatar-position-v1';
let position;
try {
  const saved = JSON.parse(localStorage.getItem(positionKey));
  if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) position = saved;
} catch {}

const SNAP_DISTANCE = 36, SNAP_MARGIN = 12;
function snapped(x, y) {
  let prefs = {};
  try { prefs = window.YatsumiTheme.readAvatar(); } catch {}
  if (prefs.snap === false) return { x, y };
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
  const near = (value, low, high) => value - low < SNAP_DISTANCE ? low + SNAP_MARGIN : high - value < SNAP_DISTANCE ? high - SNAP_MARGIN : value;
  return {
    x: near(x, left, left + width - avatar.offsetWidth),
    y: near(y, top, top + height - avatar.offsetHeight)
  };
}
function refitAvatar() {
  if (avatar.hidden || !position) return;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
  const maxX = left + Math.max(0, (viewport?.width ?? innerWidth) - avatar.offsetWidth);
  const maxY = top + Math.max(0, (viewport?.height ?? innerHeight) - avatar.offsetHeight);
  avatar.style.left = Math.max(left, Math.min(position.x, maxX)) + 'px';
  avatar.style.top = Math.max(top, Math.min(position.y, maxY)) + 'px';
  avatar.style.right = 'auto';
  avatar.style.bottom = 'auto';
}
avatar.querySelector('img').addEventListener('load', () => requestAnimationFrame(refitAvatar));
window.addEventListener('resize', refitAvatar);
window.visualViewport?.addEventListener('resize', refitAvatar);
window.visualViewport?.addEventListener('scroll', refitAvatar);
let drag = null;
let suppressClick = false;
avatar.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary) return;
  const rect = avatar.getBoundingClientRect();
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
  suppressClick = false;
  avatar.setPointerCapture(event.pointerId);
});
avatar.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.id) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) <= 7) return;
  drag.moved = true;
  avatar.classList.add('is-dragging');
  position = { x: drag.left + dx, y: drag.top + dy };
  refitAvatar();
});
function finishDrag(event) {
  if (!drag || event.pointerId !== drag.id) return;
  suppressClick = drag.moved;
  avatar.classList.remove('is-dragging');
  if (drag.moved) {
    const { left, top } = avatar.getBoundingClientRect();
    position = snapped(left, top);
    refitAvatar();
    try { localStorage.setItem(positionKey, JSON.stringify(position)); } catch {}
  }
  drag = null;
}
avatar.addEventListener('pointerup', finishDrag);
avatar.addEventListener('pointercancel', finishDrag);
avatar.addEventListener('lostpointercapture', finishDrag);
window.addEventListener('yatsumi:avatar-reset-position', () => {
  position = undefined;
  try { localStorage.removeItem(positionKey); } catch {}
  for (const side of ['left', 'top', 'right', 'bottom']) avatar.style[side] = '';
});
avatar.addEventListener('click', event => {
  if (suppressClick && event.detail) { suppressClick = false; return; }
  setChatOpen(!chatPanel.classList.contains('is-open'));
});
