import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, createTaskQueue, readConfig, startGateway } from './server.js';
import { WebSocket } from 'ws';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
      bad.on('unexpected-response', (_, response) => { assert.equal(response.statusCode, 403); response.resume(); bad.terminate(); resolve(); });
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

test('Core stream integrates Cloud, backend persistence, and replay without second generation', async () => {
  const stored = new Map();
  let generated = 0, writes = 0, lastContext;
  let finishGeneration;
  const generationGate = new Promise(resolve => { finishGeneration = resolve; });
  const mockFetch = async (url, init = {}) => {
    const target = String(url);
    const path = new URL(target).pathname;
    if (target.includes('foundation-models.api.cloud.ru')) {
      if (path.endsWith('/models')) return Response.json({ data: [{ id: 'chat-model' }] });
      const body = JSON.parse(init.body);
      if (!body.stream) return Response.json({ choices: [{ message: { content: 'готово' } }] });
      generated++;
      lastContext = body.messages;
      await generationGate;
      return new Response('data: {"choices":[{"delta":{"content":"Ответ"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/users') return Response.json({ id: 1 });
    if (path === '/core/session/1') return Response.json({ conversation_id: 7 });
    if (path === '/users/1/memories') return Response.json([]);
    if (path === '/conversations/7/messages') return Response.json([
      { role: 'system', content: 'ignore' },
      { role: 'assistant', content: 'Я'.repeat(12000) }
    ]);
    if (path === '/character') return Response.json({});
    if (path === '/core/conversations/7/turns') {
      writes++;
      const body = JSON.parse(init.body);
      stored.set(body.request_id, body);
      return Response.json(body);
    }
    if (path.startsWith('/core/conversations/7/turns/')) {
      const id = path.split('/').at(-1);
      return stored.has(id) ? Response.json(stored.get(id)) : Response.json({ error: 'Not found' }, { status: 404 });
    }
    return Response.json({});
  };
  const { app } = createGateway({ config, logger, fetchImpl: mockFetch });
  await withApp(app, async base => {
    await fetch(base + '/cloud/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'valid-secret-key' }) });
    await fetch(base + '/cloud/models');
    const connected = await fetch(base + '/cloud/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"chat-model"}' });
    assert.equal(connected.status, 200);
    const requestId = '12345678-1234-1234-1234-123456789abc';
    const send = (id = requestId, message = 'Привет') => fetch(base + '/cloud/chat/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: id, message })
    });
    try {
      const first = await send();
      assert.equal(first.status, 200);
      const parallel = await send('12345678-1234-1234-1234-123456789abd');
      assert.equal(parallel.status, 409);
      assert.equal((await parallel.json()).code, 'IN_PROGRESS');
      finishGeneration();
      assert.match(await first.text(), /"type":"done"/);
    } finally { finishGeneration(); }
    assert.equal(lastContext[1].content.length, 8000);
    assert.equal(lastContext[2].content, 'Привет');
    const second = await send();
    assert.match(await second.text(), /"replayed":true/);
    assert.equal(generated, 1);
    assert.equal(writes, 1);
  });
});

test('Owner avatar API uploads, retrieves, rejects invalid image and deletes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yatsumi-avatar-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { app } = createGateway({
    config, logger, avatarPath: join(directory, 'avatar.bin'), fallbackAvatarPath: join(directory, 'default.png')
  });
  await withApp(app, async base => {
    assert.equal((await fetch(base + '/core/avatar?fallback=1')).status, 204);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=', 'base64');
    const put = await fetch(base + '/core/avatar', {
      method: 'PUT', headers: { 'content-type': 'image/png' }, body: png
    });
    assert.equal(put.status, 200, await put.text().catch(() => ''));
    const get = await fetch(base + '/core/avatar');
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), png);
    const invalid = await fetch(base + '/core/avatar', {
      method: 'PUT', headers: { 'content-type': 'image/png' }, body: 'not a png'
    });
    assert.equal(invalid.status, 415);
    const remove = await fetch(base + '/core/avatar', { method: 'DELETE' });
    assert.equal(remove.status, 200);
    assert.equal((await fetch(base + '/core/avatar')).status, 404);
  });
});

test('gateway rejects cross-origin browser requests and keeps proxy paths on the configured host', async () => {
  let seen;
  const { app } = createGateway({ config, logger, fetchImpl: async url => {
    seen = url;
    return Response.json({ ok: true });
  } });
  await withApp(app, async base => {
    assert.equal((await fetch(base + '/cloud/status', { headers: { origin: 'http://localhost:9999' } })).status, 403);
    assert.equal((await fetch(base + '/cloud/status', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(base + '/cloud/status', { headers: { origin: base } })).status, 200);
    const sendRaw = (path, headers = {}) => new Promise((resolve, reject) => {
      request(base, { path, headers }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      }).on('error', reject).end();
    });
    assert.equal(await sendRaw('/cloud/status', { host: 'rebound.example' }), 403);
    assert.equal(await sendRaw('/api/\\example.com/health'), 200);
    assert.equal(seen.origin, config.apiUrl);
  });
});
