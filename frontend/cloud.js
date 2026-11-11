import { randomUUID } from 'node:crypto';

const BASE = 'https://foundation-models.api.cloud.ru/v1';
const retryable = new Set([408, 429, 500, 502, 503, 504]);
const httpMessages = {
  400: 'Некорректные параметры запроса', 401: 'API-ключ Cloud.ru недействителен или просрочен',
  403: 'Недостаточно прав для Cloud.ru или выбранной модели', 404: 'Модель или адрес API не найдены',
  408: 'Cloud.ru не успел обработать запрос', 409: 'Конфликт состояния Cloud.ru',
  413: 'Запрос слишком большой', 422: 'Cloud.ru отклонил параметры модели',
  429: 'Лимит запросов Cloud.ru превышен', 500: 'Внутренняя ошибка Cloud.ru',
  502: 'Ошибка шлюза Cloud.ru', 503: 'Cloud.ru временно недоступен',
  504: 'Истекло время ожидания Cloud.ru'
};
export class CloudError extends Error {
  constructor(code, message, httpStatus = 502, retryAfter = null) {
    super(message);
    this.name = 'CloudError'; this.code = code; this.httpStatus = httpStatus;
    this.retryAfter = retryAfter;
  }
}
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(30, Math.max(0, seconds));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(30, Math.max(0, (date - Date.now()) / 1000)) : null;
}
function networkError(error) {
  if (error instanceof CloudError) return error;
  const cause = error?.cause?.code || error?.code || '';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return new CloudError('TIMEOUT', 'Превышено время ожидания Cloud.ru', 504);
  const names = { ENOTFOUND: 'DNS Cloud.ru не найден', ECONNREFUSED: 'Соединение с Cloud.ru отклонено', ECONNRESET: 'Соединение с Cloud.ru разорвано', ETIMEDOUT: 'Сетевой таймаут Cloud.ru', CERT_HAS_EXPIRED: 'Сертификат Cloud.ru просрочен', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Ошибка проверки TLS-сертификата' };
  return new CloudError(cause || 'NETWORK', names[cause] || 'Сетевая ошибка подключения к Cloud.ru', 502);
}
function chatCapable(model) {
  const id = model.id.toLowerCase();
  const kind = String(model.type || model.task || '').toLowerCase();
  return !/(embedding|rerank|re-rank|ocr|speech|transcri|whisper|tts|image-gen)/.test(id + ' ' + kind);
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createCloudService({ fetchImpl = fetch, timeoutMs = 60000, sleep = wait } = {}) {
  let key = '', selected = '', connected = false, models = [], lastError = null;
  const emptyUsage = () => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  let verifiedAt = null, usage = emptyUsage();
  let generation = 0;
  const status = () => ({ configured: Boolean(key), connected, model: selected || null, modelsCount: models.length, error: lastError, verifiedAt, usage: { ...usage } });
  function invalidate() { generation++; connected = false; verifiedAt = null; }
  function fail(error, epoch, affectConnection = false) {
    const problem = networkError(error);
    if (epoch !== generation) return new CloudError('STALE', 'Настройки Cloud.ru изменились во время запроса', 409);
    lastError = { code: problem.code, message: problem.message, status: problem.httpStatus, retryAfter: problem.retryAfter };
    if (affectConnection) invalidate();
    return problem;
  }
  async function call(path, { method = 'GET', body, retries = 0 } = {}) {
    if (!key) throw new CloudError('NO_KEY', 'Сначала укажите API-ключ Cloud.ru', 400);
    const token = key, epoch = generation;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if (epoch !== generation) throw new CloudError('STALE', 'Настройки Cloud.ru изменились во время запроса', 409);
        const response = await fetchImpl(BASE + path, {
          method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: controller.signal
        });
        if (!response.ok) await response.body?.cancel();
        if (response.status >= 300 && response.status < 400) throw new CloudError('REDIRECT', 'Неожиданное перенаправление Cloud.ru', 502);
        if (!response.ok) {
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
          if (attempt < retries && retryable.has(response.status)) {
            await sleep(Math.min(2000, retryAfter === null ? 250 * 2 ** attempt : retryAfter * 1000));
            continue;
          }
          throw new CloudError('HTTP_' + response.status, httpMessages[response.status] || 'Ошибка Cloud.ru: HTTP ' + response.status, response.status, retryAfter);
        }
        try { return await response.json(); }
        catch { throw new CloudError('INVALID_JSON', 'Cloud.ru вернул некорректный JSON', 502); }
      } catch (error) {
        const problem = controller.signal.aborted ? new CloudError('TIMEOUT', 'Превышено время ожидания Cloud.ru', 504) : networkError(error);
        if (attempt < retries && ['NETWORK', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'TIMEOUT'].includes(problem.code)) {
          await sleep(250 * 2 ** attempt); continue;
        }
        throw problem;
      } finally { clearTimeout(timer); }
    }
  }
  function collectUsage(value) {
    if (!value || typeof value !== 'object') return;
    for (const name of Object.keys(usage)) {
      if (Number.isFinite(value[name]) && value[name] >= 0) usage[name] += value[name];
    }
  }
  async function listModels() {
    const epoch = generation;
    try {
      const data = await call('/models', { retries: 2 });
      if (epoch !== generation) throw new CloudError('STALE', 'Ключ изменился во время запроса', 409);
      if (!Array.isArray(data?.data)) throw new CloudError('INVALID_MODELS', 'Cloud.ru вернул некорректный каталог моделей', 502);
      models = data.data.filter(item => item && typeof item.id === 'string' && chatCapable(item))
        .map(item => ({ id: item.id, name: item.name || item.id, type: item.type || 'chat' }))
        .sort((a, b) => a.id.localeCompare(b.id));
      lastError = null;
      return models;
    } catch (error) { throw fail(error, epoch, [401, 403].includes(error?.httpStatus)); }
  }
  async function connect(model) {
    if (typeof model !== 'string' || !models.some(item => item.id === model)) throw new CloudError('MODEL', 'Выберите чат-модель из загруженного списка', 400);
    invalidate(); selected = model;
    const epoch = generation;
    try {
      const data = await call('/chat/completions', { method: 'POST', body: { model, messages: [{ role: 'user', content: 'Ответь одним словом: готово' }], max_completion_tokens: 16 } });
      if (epoch !== generation) throw new CloudError('STALE', 'Настройки изменились во время подключения', 409);
      const answer = data?.choices?.[0]?.message?.content;
      if (typeof answer !== 'string' || !answer.trim()) throw new CloudError('INVALID_RESPONSE', 'Модель не вернула текстовый ответ', 502);
      collectUsage(data.usage); connected = true; verifiedAt = new Date().toISOString(); lastError = null;
      return status();
    } catch (error) { throw fail(error, epoch, true); }
  }
  function validateMessages(messages, allowSystem = false) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 30 ||
      messages.some(item => !item || !((allowSystem && item.role === 'system') || ['user', 'assistant'].includes(item.role)) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 8000)) {
      throw new CloudError('MESSAGES', 'Некорректная история диалога', 400);
    }
  }
  async function chat(messages) {
    if (!connected || !selected) throw new CloudError('DISCONNECTED', 'Сначала подключите модель', 409);
    validateMessages(messages);
    const epoch = generation, model = selected;
    try {
      const data = await call('/chat/completions', { method: 'POST', body: { model, messages, max_completion_tokens: 1024 } });
      if (epoch !== generation) throw new CloudError('STALE', 'Настройки изменились во время ответа', 409);
      const answer = data?.choices?.[0]?.message?.content;
      if (typeof answer !== 'string' || !answer.trim()) throw new CloudError('INVALID_RESPONSE', 'Модель вернула пустой ответ', 502);
      collectUsage(data.usage); connected = true; verifiedAt = new Date().toISOString(); lastError = null;
      return { id: randomUUID(), model, content: answer, usage: data.usage || null, finishReason: data?.choices?.[0]?.finish_reason || null };
    } catch (error) {
      const problem = networkError(error);
      // A transient request error is not proof that the model or credentials stopped working.
      throw fail(problem, epoch, [401, 403, 404].includes(problem.httpStatus));
    }
  }
  async function streamChat(messages, emit, signal, allowSystem = false) {
    if (!connected || !selected) throw new CloudError('DISCONNECTED', 'Сначала подключите модель', 409);
    validateMessages(messages, allowSystem);
    const epoch = generation, model = selected;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let reader;
    try {
      const response = await fetchImpl(BASE + '/chat/completions', {
        method: 'POST', redirect: 'manual',
        headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model, messages, max_completion_tokens: 1024, stream: true, stream_options: { include_usage: true } }),
        signal: controller.signal
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 300 && response.status < 400) throw new CloudError('REDIRECT', 'Неожиданное перенаправление Cloud.ru', 502);
        throw new CloudError('HTTP_' + response.status, httpMessages[response.status] || 'Ошибка Cloud.ru: HTTP ' + response.status, response.status, parseRetryAfter(response.headers.get('retry-after')));
      }
      if (!response.body) throw new CloudError('STREAM', 'Cloud.ru не вернул поток данных', 502);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', answer = '', streamUsage = null, complete = false;
      while (!complete) {
        const { value, done } = await reader.read();
        if (epoch !== generation) throw new CloudError('STALE', 'Настройки изменились во время ответа', 409);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop();
        if (buffer.length > 262144) throw new CloudError('STREAM_SIZE', 'Слишком большой потоковый ответ', 502);
        for (const part of parts) {
          if (part.length > 262144) throw new CloudError('STREAM_SIZE', 'Слишком большой потоковый ответ', 502);
          const data = part.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          if (data.trim() === '[DONE]') {
            complete = true;
            break;
          }
          let chunk;
          try { chunk = JSON.parse(data); } catch { throw new CloudError('STREAM_JSON', 'Cloud.ru вернул некорректный фрагмент потока', 502); }
          if (chunk?.error) throw new CloudError('STREAM', 'Cloud.ru сообщил об ошибке во время ответа', 502);
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            answer += delta;
            if (answer.length > 200000) throw new CloudError('STREAM_SIZE', 'Ответ модели слишком длинный', 502);
            emit({ type: 'delta', content: delta });
          }
          if (chunk?.usage) streamUsage = chunk.usage;
        }
      }
      if (!complete) throw new CloudError('STREAM_INCOMPLETE', 'Соединение оборвалось до завершения ответа Cloud.ru', 502);
      if (!answer.trim()) throw new CloudError('INVALID_RESPONSE', 'Модель вернула пустой ответ', 502);
      collectUsage(streamUsage);
      connected = true; verifiedAt = new Date().toISOString(); lastError = null;
      emit({ type: 'done', model, usage: streamUsage });
    } catch (error) {
      if (signal?.aborted) throw new CloudError('CANCELLED', 'Запрос отменён', 409);
      throw fail(error, epoch, [401, 403, 404].includes(error?.httpStatus));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (reader) void reader.cancel().catch(() => {});
    }
  }
  return {
    status, listModels, connect, chat, streamChat,
    setKey(value) {
      if (typeof value !== 'string' || value.length > 4096 || !/^[!-~]{8,}$/.test(value.trim())) throw new CloudError('KEY', 'Некорректный API-ключ', 400);
      invalidate(); key = value.trim(); selected = ''; models = []; lastError = null; usage = emptyUsage();
      return status();
    },
    clear() { invalidate(); key = ''; selected = ''; models = []; lastError = null; usage = emptyUsage(); return status(); }
  };
}
