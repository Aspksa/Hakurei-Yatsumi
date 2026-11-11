import express from 'express';
const app = express();
const api = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';
const key = process.env.YATSUMI_API_KEY;
if (!key) throw new Error('Set YATSUMI_API_KEY');
app.use(express.json({ limit: '128kb' }));
// Local-only gateway. Add user authentication before exposing it externally.
app.use('/api', async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const target = new URL('/' + req.path.replace(/^\/+/, ''), api);
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') target.searchParams.set(k, v);
    }
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'x-api-key': key,
        ...(req.method !== 'GET' && req.method !== 'HEAD' ? { 'content-type': 'application/json' } : {})
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
      signal: controller.signal
    });
    const response = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(response);
  } catch {
    res.status(502).json({ error: 'Python API unavailable' });
  } finally {
    clearTimeout(timeout);
  }
});
app.listen(3000, '127.0.0.1', () => console.log('Yatsumi gateway: http://127.0.0.1:3000'));
