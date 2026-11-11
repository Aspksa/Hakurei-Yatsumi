import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, createTaskQueue, readConfig, startGateway } from './server.js';
import { WebSocket } from 'ws';

const config = { ...readConfig({ YATSUMI_API_KEY: 'secret' }), apiKey: 'secret' };
const logger = () => {};
async function withApp(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await work('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('rejects unsafe configuration', () => {
  assert.throws(() => readConfig({ PYTHON_API_URL: 'https://example.com', YATSUMI_API_KEY: 'x' }), /local HTTP/);
  assert.throws(() => readConfig({ YATSUMI_NODE_PORT: 'abc' }), /numeric/);
  assert.throws(() => createGateway({ config: { ...config, apiKey: '' } }), /API_KEY/);
});
test('health reports Python status and queue state', async () => {
  const { app } = createGateway({ config, logger, fetchImpl: async () => new Response('{"status":"ok","sqlite":"ok"}') });
  await withApp(app, async base => {
    const response = await fetch(base + '/gateway/health');
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.python, 'ok');
    assert.equal(data.sqlite, 'ok');
  });
});
test('proxy preserves query, method, request ID and key without injecting DELETE body', async () => {
  let seen;
  const { app } = createGateway({ config, logger, fetchImpl: async (url, init) => {
    seen = { url: String(url), init };
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  } });
  await withApp(app, async base => {
    const response = await fetch(base + '/api/health?x=1&x=2', { method: 'DELETE', headers: { 'x-request-id': 'trace-123' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'trace-123');
    assert.equal(seen.url, 'http://127.0.0.1:8000/health?x=1&x=2');
    assert.equal(seen.init.headers['x-api-key'], 'secret');
    assert.equal(seen.init.headers['x-request-id'], 'trace-123');
    assert.equal(seen.init.body, undefined);
  });
});
test('rejects foreign origin and malformed JSON', async () => {
  const { app } = createGateway({ config, logger, fetchImpl: async () => new Response('{}') });
  await withApp(app, async base => {
    assert.equal((await fetch(base + '/api/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(base + '/api/health', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  });
});
test('rejects redirect and masks upstream errors', async () => {
  const { app } = createGateway({ config, logger, fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://example.com' } }) });
  await withApp(app, async base => assert.equal((await fetch(base + '/api/health')).status, 502));
  const broken = createGateway({ config, logger, fetchImpl: async () => { throw new Error('secret'); } });
  await withApp(broken.app, async base => {
    const response = await fetch(base + '/api/health');
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /secret/);
  });
});
test('queue enforces concurrency and limit', async () => {
  const q = createTaskQueue({ concurrency: 1, limit: 2 });
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const first = q.submit(() => hold);
  const second = q.submit(() => 2);
  await assert.rejects(q.submit(() => 3), /Queue full/);
  release(1);
  assert.equal(await first, 1);
  assert.equal(await second, 2);
});
test('WebSocket rejects missing key and accepts authenticated ping', async () => {
  const gateway = startGateway({ config: { ...config, port: 0 }, logger, fetchImpl: async () => new Response('{}') });
  await new Promise(resolve => gateway.server.once('listening', resolve));
  try {
    const url = 'ws://127.0.0.1:' + gateway.server.address().port + '/ws';
    await new Promise((resolve, reject) => {
      const bad = new WebSocket(url);
      bad.on('unexpected-response', (_, response) => { assert.equal(response.statusCode, 403); resolve(); });
      bad.on('error', reject);
    });
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { 'x-api-key': 'secret' } });
      socket.on('message', data => {
        const message = JSON.parse(String(data));
        if (message.type === 'ready') socket.send(JSON.stringify({ type: 'ping' }));
        if (message.type === 'pong') { socket.close(); resolve(); }
      });
      socket.on('error', reject);
    });
  } finally { gateway.shutdown(); await new Promise(resolve => gateway.server.once('close', resolve)); }
});
