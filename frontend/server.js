import express from 'express';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCloudService } from './cloud.js';
import { createYatsumiCore } from './core.js';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const allowedMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const originHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

function integer(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('Invalid gateway numeric configuration');
  return number;
}
export function readConfig(env = process.env) {
  const apiUrl = env.PYTHON_API_URL || 'http://127.0.0.1:8000';
  const url = new URL(apiUrl);
  if (url.protocol !== 'http:' || !localHosts.has(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PYTHON_API_URL must be a local HTTP origin');
  }
  return {
    apiUrl: url.origin,
    port: integer(env.YATSUMI_NODE_PORT, 3000, 1, 65535),
    timeoutMs: integer(env.YATSUMI_PROXY_TIMEOUT_MS, 10000, 100, 120000),
    queueLimit: integer(env.YATSUMI_QUEUE_LIMIT, 32, 1, 1024),
    queueConcurrency: integer(env.YATSUMI_QUEUE_CONCURRENCY, 2, 1, 32),
    logPath: env.YATSUMI_NODE_LOG || '',
    apiKey: env.YATSUMI_API_KEY || ''
  };
}
function safeId(value) { return typeof value === 'string' && idPattern.test(value) ? value : randomUUID(); }
function safeOrigin(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && originHosts.has(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
function equalKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function makeLogger(logPath = '') {
  return (level, event, data = {}) => {
    const entry = { time: new Date().toISOString(), level, event, ...data };
    const line = JSON.stringify(entry);
    if (!logPath) { process.stdout.write(line + '\n'); return; }
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      if (existsSync(logPath) && statSync(logPath).size > 2 * 1024 * 1024) renameSync(logPath, logPath + '.old');
      appendFileSync(logPath, line + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch { process.stderr.write('Gateway logging failed\n'); }
  };
}
export function createTaskQueue({ concurrency = 2, limit = 32 } = {}) {
  const pending = [];
  let active = 0;
  let closed = false;
  function pump() {
    while (!closed && active < concurrency && pending.length) {
      const job = pending.shift();
      active++;
      Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  }
  return {
    submit(work) {
      if (closed) return Promise.reject(new Error('Queue closed'));
      if (pending.length + active >= limit) return Promise.reject(new Error('Queue full'));
      return new Promise((resolve, reject) => { pending.push({ work, resolve, reject }); pump(); });
    },
    stats() { return { active, pending: pending.length, capacity: limit }; },
    close() { closed = true; for (const job of pending.splice(0)) job.reject(new Error('Queue closed')); }
  };
}
export function createGateway({ config = readConfig(), fetchImpl = fetch, logger = makeLogger(config.logPath) } = {}) {
  if (!config.apiKey) throw new Error('Set YATSUMI_API_KEY');
  const url = new URL(config.apiUrl);
  if (url.protocol !== 'http:' || !localHosts.has(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Invalid local Python origin');
  const app = express();
  const cloud = createCloudService({ fetchImpl });
  const core = createYatsumiCore({ fetchImpl, apiUrl: config.apiUrl, apiKey: config.apiKey });
  const activeTurns = new Set();
  const queue = createTaskQueue({ concurrency: config.queueConcurrency, limit: config.queueLimit });
  const clients = new Map();
  const metrics = { requests: 0, failures: 0, started: Date.now() };
  app.disable('x-powered-by');
  app.disable('etag');
  app.use((req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    const requestId = safeId(req.get('x-request-id'));
    res.setHeader('x-request-id', requestId);
    req.requestId = requestId;
    if (!safeOrigin(req.get('origin'))) return res.status(403).json({ error: 'Origin rejected' });
    if (!allowedMethods.has(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    const now = Date.now();
    const old = clients.get(req.ip);
    const bucket = !old || now - old.start >= 60000 ? { start: now, count: 0 } : old;
    bucket.count++;
    clients.set(req.ip, bucket);
    if (clients.size > 1024) for (const [ip, b] of clients) if (now - b.start >= 60000) clients.delete(ip);
    if (bucket.count > 120) return res.status(429).json({ error: 'Rate limit exceeded' });
    metrics.requests++;
    res.once('finish', () => logger('info', 'request', { requestId, method: req.method, status: res.statusCode, durationMs: Date.now() - now }));
    next();
  });
  // Single-owner avatar API: persisted as one file inside frontend/data.
  const avatarDirectory = join(fileURLToPath(new URL('.', import.meta.url)), 'data');
  const avatarPath = join(avatarDirectory, 'avatar.bin');
  const avatarFormats = [
    { type: 'image/png', match: bytes => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
    { type: 'image/jpeg', match: bytes => bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 },
    { type: 'image/webp', match: bytes => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' }
  ];
  app.get('/core/avatar', async (_req, res) => {
    try {
      const bytes = await readFile(avatarPath);
      const type = avatarFormats.find(format => format.match(bytes))?.type;
      if (!type) return res.status(500).json({ error: 'Повреждённый аватар' });
      res.setHeader('content-type', type);
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      return res.end(bytes);
    } catch (error) {
      return res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: 'Аватар не найден' });
    }
  });
  app.put('/core/avatar', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '10mb' }), async (req, res) => {
    const bytes = req.body;
    const format = avatarFormats.find(item => item.type === req.get('content-type')?.split(';')[0] &&
      Buffer.isBuffer(bytes) && bytes.length > 0 && item.match(bytes));
    if (!format) return res.status(415).json({ error: 'Нужен корректный PNG, JPEG или WebP' });
    const tmp = join(avatarDirectory, '.' + randomUUID() + '.tmp');
    try {
      await mkdir(avatarDirectory, { recursive: true });
      await writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
      await rename(tmp, avatarPath);
      return res.json({ ok: true, type: format.type, size: bytes.length });
    } catch {
      return res.status(500).json({ error: 'Не удалось сохранить аватар' });
    } finally { await rm(tmp, { force: true }).catch(() => {}); }
  });
  app.delete('/core/avatar', async (_req, res) => {
    try {
      await rm(avatarPath, { force: true });
      return res.json({ ok: true });
    } catch { return res.status(500).json({ error: 'Не удалось удалить аватар' }); }
  });
  app.use(express.json({ limit: '128kb', strict: true }));
  app.get('/gateway/health', async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 2000));
    try {
      const upstream = await fetchImpl(new URL('/health', config.apiUrl), { headers: { 'x-api-key': config.apiKey }, signal: controller.signal, redirect: 'manual' });
      if (!upstream.ok) throw new Error('Python unhealthy');
      const detail = await upstream.json();
      if (detail.sqlite !== 'ok') throw new Error('SQLite unhealthy');
      res.json({ status: 'ok', node: 'ok', python: 'ok', sqlite: 'ok', uptimeSeconds: Math.floor((Date.now() - metrics.started) / 1000), queue: queue.stats() });
    } catch {
      res.status(503).json({ status: 'degraded', node: 'ok', python: 'unavailable', sqlite: 'unknown', queue: queue.stats() });
    } finally { clearTimeout(timer); }
  });
  const publicDir = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
  app.use(express.static(publicDir, { index: 'index.html', dotfiles: 'deny', etag: false }));
  const cloudError = (res, error) => {
    const code = error?.code || 'INTERNAL';
    const status = Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? error.httpStatus : 502;
    if (error?.retryAfter !== null && Number.isFinite(error?.retryAfter)) res.setHeader('retry-after', String(Math.ceil(error.retryAfter)));
    res.status(status).json({ error: error?.message || 'Ошибка Cloud.ru', code, status });
  };
  app.get('/cloud/status', (req, res) => res.json(cloud.status()));
  app.post('/cloud/key', (req, res) => {
    try { res.json(cloud.setKey(req.body?.key)); }
    catch (error) { cloudError(res, error); }
  });
  app.delete('/cloud/key', (req, res) => res.json(cloud.clear()));
  app.get('/cloud/models', async (req, res) => {
    try { res.json({ models: await cloud.listModels() }); }
    catch (error) { cloudError(res, error); }
  });
  app.post('/cloud/connect', async (req, res) => {
    try { res.json(await cloud.connect(req.body?.model)); }
    catch (error) { cloudError(res, error); }
  });
  app.post('/cloud/chat', async (req, res) => {
    try { res.json(await cloud.chat(req.body?.messages)); }
    catch (error) { cloudError(res, error); }
  });
  app.get('/core/history', async (req, res) => {
    try { res.json({ messages: await core.history() }); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.post('/core/memory', async (req, res) => {
    try { res.json(await core.remember(req.body?.key, req.body?.value)); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cloud/chat/stream', async (req, res) => {
    const requestId = req.body?.requestId;
    if (typeof requestId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(requestId)) {
      return res.status(400).json({ error: 'Нужен уникальный requestId для безопасного сохранения' });
    }
    if (activeTurns.has(requestId)) {
      return res.status(409).json({ error: 'Этот запрос уже обрабатывается', code: 'IN_PROGRESS' });
    }
    activeTurns.add(requestId);
    const controller = new AbortController();
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-store');
    res.setHeader('x-accel-buffering', 'no');
    const send = value => { if (!res.destroyed && !res.writableEnded) res.write('data: ' + JSON.stringify(value) + '\n\n'); };
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const messages = req.body?.messages;
      if (!Array.isArray(messages) || !messages.length || messages.at(-1)?.role !== 'user' ||
          typeof messages.at(-1)?.content !== 'string') throw new Error('Некорректная история диалога');
      const previous = await core.getTurn(requestId);
      if (previous) {
        if (previous.user_content !== messages.at(-1).content) throw new Error('ID запроса уже использован для другого сообщения');
        send({ type: 'delta', content: previous.assistant_content });
        send({ type: 'done', requestId, replayed: true });
        return;
      }
      const context = await core.prepare(messages);
      let answer = '';
      let completed = false;
      await cloud.streamChat(context.messages, event => {
        if (event.type === 'delta') { answer += event.content; send(event); }
        if (event.type === 'done') completed = true;
      }, controller.signal, true);
      if (!completed) throw new Error('Cloud.ru не завершил генерацию');
      // Save must complete before signalling done to the browser.
      await core.save(messages.at(-1).content, answer, requestId);
      send({ type: 'done', requestId, model: cloud.status().model, usedMemoryKeys: context.usedMemoryKeys });
    } catch (error) {
      send({ type: 'error', code: error?.code || 'CORE_FAILURE',
        error: error?.message || 'Ошибка ядра Яцуми' });
    } finally {
      activeTurns.delete(requestId);
      res.off('close', onClose);
      res.end();
    }
  });
  app.use('/api', async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const target = new URL('/' + req.path.replace(/^\/+/, ''), config.apiUrl);
      target.search = new URL(req.originalUrl, 'http://localhost').search;
      const hasBody = !['GET', 'HEAD'].includes(req.method) && req.body !== undefined;
      const upstream = await (req.method === 'POST' ? queue.submit(() => fetchImpl(target, {
        method: req.method,
        headers: { 'x-api-key': config.apiKey, 'x-request-id': req.requestId, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
        ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
        signal: controller.signal, redirect: 'manual'
      })) : fetchImpl(target, {
        method: req.method,
        headers: { 'x-api-key': config.apiKey, 'x-request-id': req.requestId, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
        ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
        signal: controller.signal, redirect: 'manual'
      }));
      if (upstream.status >= 300 && upstream.status < 400) return res.status(502).json({ error: 'Upstream redirect rejected' });
      const body = await upstream.text();
      const contentType = upstream.headers.get('content-type') || 'application/json';
      res.status(upstream.status).type(contentType).send(body);
    } catch (error) {
      metrics.failures++;
      logger('warn', 'upstream_failure', { requestId: req.requestId, type: error?.name === 'AbortError' ? 'timeout' : 'unavailable' });
      res.status(error?.message === 'Queue full' ? 503 : error?.name === 'AbortError' ? 504 : 502).json({ error: error?.message === 'Queue full' ? 'Gateway busy' : 'Python API unavailable' });
    } finally { clearTimeout(timer); }
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status === 413 ? 413 : 400;
    res.status(status).json({ error: status === 413 ? 'Payload too large' : 'Invalid JSON' });
  });
  return { app, queue, metrics, config, logger };
}
export function startGateway(options = {}) {
  const gateway = createGateway(options);
  const server = createServer(gateway.app);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 64;
  const ws = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const sockets = new Set();
  ws.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.send(JSON.stringify({ type: 'ready', status: 'ok' }));
    socket.on('message', async data => {
      let input;
      try { input = JSON.parse(String(data)); } catch { socket.close(1003, 'Invalid JSON'); return; }
      if (!input || input.type !== 'ping') { socket.send(JSON.stringify({ type: 'error', error: 'Unsupported message' })); return; }
      socket.send(JSON.stringify({ type: 'pong' }));
    });
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0] !== '/ws' || !safeOrigin(req.headers.origin) || !equalKey(req.headers['x-api-key'], gateway.config.apiKey)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client, req));
  });
  server.listen(gateway.config.port, '127.0.0.1', () => gateway.logger('info', 'gateway_started', { port: gateway.config.port }));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    gateway.queue.close();
    for (const socket of sockets) socket.close(1001, 'Server shutting down');
    ws.close();
    server.close();
    setTimeout(() => { for (const socket of sockets) socket.terminate(); server.closeAllConnections(); }, 5000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...gateway, server, ws, shutdown };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startGateway();
