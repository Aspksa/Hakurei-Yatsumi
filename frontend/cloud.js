import { randomUUID } from 'node:crypto';

const CLOUD_URL = 'https://foundation-models.api.cloud.ru/v1';
export function createCloudService({ fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  let key = '';
  let selected = '';
  let connected = false;
  let models = [];
  let lastError = '';
  function status() {
    return { configured: Boolean(key), connected, model: selected || null, modelsCount: models.length, error: lastError || null };
  }
  async function call(path, options = {}) {
    if (!key) throw new Error('Сначала укажите API-ключ Cloud.ru');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(CLOUD_URL + path, {
        ...options,
        headers: { Authorization: 'Bearer ' + key, ...(options.body ? { 'content-type': 'application/json' } : {}) },
        signal: controller.signal,
        redirect: 'manual'
      });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Ключ Cloud.ru отклонён' : 'Cloud.ru API: HTTP ' + response.status);
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  return {
    status,
    setKey(value) {
      if (typeof value !== 'string' || value.trim().length < 8 || value.length > 4096) throw new Error('Некорректный API-ключ');
      key = value.trim();
      selected = ''; connected = false; models = []; lastError = '';
      return status();
    },
    clear() { key = ''; selected = ''; connected = false; models = []; lastError = ''; return status(); },
    async listModels() {
      try {
        const data = await call('/models');
        if (!Array.isArray(data.data)) throw new Error('Некорректный ответ каталога моделей');
        models = data.data.filter(item => typeof item?.id === 'string').map(item => ({ id: item.id, name: item.id })).sort((a, b) => a.id.localeCompare(b.id));
        lastError = '';
        return models;
      } catch (error) { connected = false; lastError = error.message; throw error; }
    },
    async connect(model) {
      if (typeof model !== 'string' || !models.some(item => item.id === model)) throw new Error('Выберите модель из загруженного списка');
      selected = model;
      connected = false;
      try {
        // Confirm API reachability and model presence; generation is verified on first chat.
        await this.listModels();
        if (!models.some(item => item.id === selected)) throw new Error('Модель больше недоступна');
        const probe = await call('/chat/completions', { method: 'POST', body: JSON.stringify({ model: selected, messages: [{ role: 'user', content: 'Ответь одним словом: готово' }], max_tokens: 12 }) });
        if (typeof probe?.choices?.[0]?.message?.content !== 'string') throw new Error('Модель не ответила на проверку');
        connected = true; lastError = '';
        return status();
      } catch (error) { connected = false; lastError = error.message; throw error; }
    },
    async chat(messages) {
      if (!connected || !selected) throw new Error('Сначала подключите модель');
      if (!Array.isArray(messages) || messages.length < 1 || messages.length > 30 || messages.some(item => !['user', 'assistant'].includes(item?.role) || typeof item.content !== 'string' || item.content.length > 8000)) throw new Error('Некорректная история диалога');
      try {
        const data = await call('/chat/completions', { method: 'POST', body: JSON.stringify({ model: selected, messages, max_tokens: 1024 }) });
        const answer = data?.choices?.[0]?.message?.content;
        if (typeof answer !== 'string') throw new Error('Модель вернула пустой ответ');
        connected = true; lastError = '';
        return { id: randomUUID(), model: selected, content: answer };
      } catch (error) { connected = false; lastError = error.message; throw error; }
    }
  };
}
