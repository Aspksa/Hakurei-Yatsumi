import express from 'express';
import { pathToFileURL } from 'node:url';

export function createGateway({ apiUrl = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000', apiKey = process.env.YATSUMI_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('Set YATSUMI_API_KEY');
  const api = new URL(apiUrl);
  if (api.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) || api.username || api.password || api.search || api.hash || api.pathname !== '/') {
    throw new Error('PYTHON_API_URL must be a local HTTP origin');
  }
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));
  const clients = new Map();
  app.use('/api', async (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    const previous = clients.get(ip);
    const bucket = !previous || now - previous.start >= 60000 ? { start: now, count: 0 } : previous;
    bucket.count++;
    clients.set(ip, bucket);
    if (clients.size > 1024) for (const [address, value] of clients) if (now - value.start >= 60000) clients.delete(address);
    if (bucket.count > 120) return res.status(429).json({ error: 'Rate limit exceeded' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const target = new URL('/' + req.path.replace(/^\/+/, ''), api);
      const original = new URL(req.originalUrl, 'http://localhost');
      target.search = original.search;
      const hasBody = !['GET', 'HEAD'].includes(req.method) && req.body !== undefined;
      const upstream = await fetchImpl(target, {
        method: req.method,
        headers: { 'x-api-key': apiKey, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
        ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
        signal: controller.signal,
        redirect: 'manual'
      });
      const response = await upstream.text();
      if ([301, 302, 303, 307, 308].includes(upstream.status)) return res.status(502).json({ error: 'Upstream redirect rejected' });
      const contentType = upstream.headers.get('content-type') || 'application/json';
      res.status(upstream.status).type(contentType).send(response);
    } catch (error) {
      res.status(error?.name === 'AbortError' ? 504 : 502).json({ error: 'Python API unavailable' });
    } finally {
      clearTimeout(timeout);
    }
  });
  return app;
}

export function startGateway(options = {}) {
  const app = createGateway(options);
  const server = app.listen(3000, '127.0.0.1', () => console.log('Yatsumi gateway: http://127.0.0.1:3000'));
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startGateway();
