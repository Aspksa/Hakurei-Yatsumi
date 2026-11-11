const $ = id => document.getElementById(id);
const overlay = $('overlay');
const history = [];
let connected = false;
function openSettings() { overlay.hidden = false; $('apiKey').focus(); }
function closeSettings() { overlay.hidden = true; $('settingsOpen').focus(); }
function notice(text) { $('notice').textContent = text; }
function setStatus(state) {
  connected = Boolean(state.connected);
  const label = connected ? 'Модель работает' : state.configured ? 'Не подключено' : 'Нет подключения';
  for (const id of ['headerDot', 'panelDot']) $('' + id).className = 'dot ' + (connected ? 'green' : 'red');
  $('headerStatus').textContent = label;
  $('panelStatus').textContent = label;
  $('send').disabled = !connected;
  const usage = state.usage;
  if (usage && $('tokenUsage')) $('tokenUsage').textContent = 'Токены: ' + (usage.total_tokens || 0) + ' · вход ' + (usage.prompt_tokens || 0) + ' · выход ' + (usage.completion_tokens || 0);
  $('message').placeholder = connected ? 'Напиши сообщение Яцуми…' : 'Сначала подключите модель в настройках…';
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Ошибка подключения');
  return result;
}
async function refreshModels() {
  const select = $('modelSelect');
  select.disabled = true;
  select.replaceChildren(new Option('Загрузка моделей…', ''));
  $('connectModel').disabled = true;
  try {
    const data = await api('/cloud/models');
    select.replaceChildren(new Option('Выберите модель', ''), ...data.models.map(m => new Option(m.name, m.id)));
    select.disabled = data.models.length === 0;
    $('modelCount').textContent = 'Доступно моделей: ' + data.models.length;
    notice(data.models.length ? 'Модели загружены. Выберите нужную.' : 'Cloud.ru вернул пустой список моделей.');
  } catch (error) {
    select.replaceChildren(new Option('Не удалось загрузить модели', ''));
    $('modelCount').textContent = 'Ошибка загрузки';
    notice(error.message);
    try { setStatus(await api('/cloud/status')); } catch {}
  }
}
$('saveMemory').addEventListener('click', async () => {
  const key = $('memoryKey').value.trim(), value = $('memoryValue').value.trim();
  if (!key || !value) return notice('Укажите название и содержание воспоминания.');
  $('saveMemory').disabled = true;
  try {
    await api('/core/memory', { method: 'POST', body: JSON.stringify({ key, value }) });
    $('memoryKey').value = ''; $('memoryValue').value = '';
    notice('Воспоминание сохранено в SQLite.');
  } catch (error) { notice(error.message); }
  finally { $('saveMemory').disabled = false; }
});
$('settingsOpen').addEventListener('click', openSettings);
$('setupStart').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', closeSettings);
$('settingsCloseBackdrop').addEventListener('click', closeSettings);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !overlay.hidden) closeSettings(); });
$('toggleKey').addEventListener('click', () => { $('apiKey').type = $('apiKey').type === 'password' ? 'text' : 'password'; });
$('saveKey').addEventListener('click', async () => {
  const key = $('apiKey').value.trim();
  if (!key) return notice('Вставьте API-ключ Cloud.ru.');
  $('saveKey').disabled = true;
  try {
    const state = await api('/cloud/key', { method: 'POST', body: JSON.stringify({ key }) });
    $('apiKey').value = '';
    setStatus(state);
    notice('Ключ принят локальным сервером. Загружаю модели…');
    await refreshModels();
  } catch (error) { notice(error.message); }
  finally { $('saveKey').disabled = false; }
});
$('reloadModels').addEventListener('click', refreshModels);
$('modelSelect').addEventListener('change', () => { $('connectModel').disabled = !$('modelSelect').value; });
$('connectModel').addEventListener('click', async () => {
  $('connectModel').disabled = true;
  try {
    const state = await api('/cloud/connect', { method: 'POST', body: JSON.stringify({ model: $('modelSelect').value }) });
    setStatus(state);
    try { localStorage.setItem('yatsumi-cloud-model', state.model || ''); } catch {}
    notice('Модель подключена. Можно начать диалог.');
    closeSettings();
  } catch (error) { notice(error.message); try { setStatus(await api('/cloud/status')); } catch {} }
  finally { $('connectModel').disabled = !$('modelSelect').value; }
});
$('forgetKey').addEventListener('click', async () => {
  try {
    const state = await api('/cloud/key', { method: 'DELETE' });
    setStatus(state);
    $('modelSelect').replaceChildren(new Option('Сначала добавьте API-ключ', ''));
    $('modelSelect').disabled = true;
    $('connectModel').disabled = true;
    $('modelCount').textContent = 'Модели ещё не загружены';
    try { localStorage.removeItem('yatsumi-cloud-model'); } catch {}
    notice('Ключ сброшен.');
  } catch (error) { notice(error.message); }
});
function bubble(role, content) {
  const element = document.createElement('div');
  element.className = 'bubble ' + role;
  element.textContent = content;
  $('conversation').append(element);
  element.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return element;
}
$('chatForm').addEventListener('submit', async event => {
  event.preventDefault();
  const content = $('message').value.trim();
  if (!content || !connected) return;
  $('welcome').hidden = true;
  $('conversation').hidden = false;
  $('message').value = '';
  bubble('user', content);
  history.push({ role: 'user', content });
  const loading = bubble('assistant', 'Яцуми думает…');
  $('send').disabled = true;
  try {
    const response = await fetch('/cloud/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: history.slice(-30) }) });
    if (!response.ok || !response.body) throw new Error('Поток Cloud.ru недоступен: HTTP ' + response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', answer = '', complete = false;
    loading.textContent = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop();
      for (const part of parts) {
        const data = part.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === 'error') throw new Error(event.error);
        if (event.type === 'delta') { answer += event.content; loading.textContent = answer; }
        if (event.type === 'done') complete = true;
      }
    }
    if (!complete) throw new Error('Соединение оборвалось до завершения ответа');
    history.push({ role: 'assistant', content: answer });
    try { setStatus(await api('/cloud/status')); } catch {}
  } catch (error) {
    loading.textContent = 'Ошибка: ' + error.message;
    history.pop();
    try { setStatus(await api('/cloud/status')); } catch {}
  } finally { $('send').disabled = !connected; }
});
$('message').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('chatForm').requestSubmit(); } });
(async () => {
  try {
    const state = await api('/cloud/status');
    setStatus(state);
    try {
      const saved = await api('/core/history');
      if (Array.isArray(saved.messages) && saved.messages.length) {
        $('welcome').hidden = true; $('conversation').hidden = false;
        for (const message of saved.messages) {
          if (['user', 'assistant'].includes(message.role)) {
            history.push({ role: message.role, content: message.content });
            bubble(message.role, message.content);
          }
        }
      }
    } catch { /* SQLite may be offline; cloud status remains independently usable */ }
    if (state.configured) await refreshModels();
    let preferred = state.model;
    try { preferred ||= localStorage.getItem('yatsumi-cloud-model'); } catch {}
    if (preferred && [...$('modelSelect').options].some(option => option.value === preferred)) { $('modelSelect').value = preferred; $('connectModel').disabled = false; }
  } catch { setStatus({ configured: false, connected: false }); }
})();
