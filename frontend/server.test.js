import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from './server.js';

async function request(app, path, init = {}) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const port = server.address().port;
    return await fetch('http://127.0.0.1:' + port + path, init);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('rejects remote upstreams and missing API key', () => {
  assert.throws(() => createGateway({ apiKey: '' }), /API_KEY/);
  assert.throws(() => createGateway({ apiKey: 'secret', apiUrl: 'https://example.com/' }), /local HTTP/);
  assert.throws(() => createGateway({ apiKey: 'secret', apiUrl: 'http://127.0.0.1@evil.com/' }), /local HTTP/);
});

test('proxies query and API key, without body on DELETE', async () => {
  let captured;
  const app = createGateway({ apiKey: 'secret', fetchImpl: async (url, init) => {
    captured = { url: String(url), init };
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const response = await request(app, '/api/health?x=1&x=2', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'http://127.0.0.1:8000/health?x=1&x=2');
  assert.equal(captured.init.headers['x-api-key'], 'secret');
  assert.equal(captured.init.body, undefined);
});

test('does not follow upstream redirects', async () => {
  const app = createGateway({ apiKey: 'secret', fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://example.com' } }) });
  const response = await request(app, '/api/health');
  assert.equal(response.status, 502);
});

test('returns 502 when upstream unavailable', async () => {
  const app = createGateway({ apiKey: 'secret', fetchImpl: async () => { throw new Error('connection failed'); } });
  const response = await request(app, '/api/health');
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret/);
});

test('limits requests to 120 per minute', async () => {
  const app = createGateway({ apiKey: 'secret', fetchImpl: async () => new Response('{}') });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    for (let i = 0; i < 120; i++) {
      const r = await fetch(base + '/api/health');
      assert.equal(r.status, 200);
      await r.arrayBuffer();
    }
    const limited = await fetch(base + '/api/health');
    assert.equal(limited.status, 429);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
