import express from 'express';
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
  app.use(express.json({ limit: '128kb', strict: true }));
  app.get('/gateway/health', async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 2000));
    try {
      const upstream = await fetchImpl(new URL('/health', config.apiUrl), { headers: { 'x-api-key': config.apiKey }, signal: controller.signal, redirect: 'manual' });
      if (!upstream.ok) throw new Error('Python unhealthy');
      res.json({ status: 'ok', node: 'ok', python: 'ok', sqlite: 'via-python', uptimeSeconds: Math.floor((Date.now() - metrics.started) / 1000), queue: queue.stats() });
    } catch {
      res.status(503).json({ status: 'degraded', node: 'ok', python: 'unavailable', sqlite: 'unknown', queue: queue.stats() });
    } finally { clearTimeout(timer); }
  });
  app.use('/api', async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const target = new URL('/' + req.path.replace(/^\/+/, ''), config.apiUrl);
      target.search = new URL(req.originalUrl, 'http://localhost').search;
      const hasBody = !['GET', 'HEAD'].includes(req.method) && req.body !== undefined;
      const upstream = await fetchImpl(target, {
        method: req.method,
        headers: { 'x-api-key': config.apiKey, 'x-request-id': req.requestId, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
        ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
        signal: controller.signal, redirect: 'manual'
      });
      if (upstream.status >= 300 && upstream.status < 400) return res.status(502).json({ error: 'Upstream redirect rejected' });
      const body = await upstream.text();
      const contentType = upstream.headers.get('content-type') || 'application/json';
      res.status(upstream.status).type(contentType).send(body);
    } catch (error) {
      metrics.failures++;
      logger('warn', 'upstream_failure', { requestId: req.requestId, type: error?.name === 'AbortError' ? 'timeout' : 'unavailable' });
      res.status(error?.name === 'AbortError' ? 504 : 502).json({ error: 'Python API unavailable' });
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
