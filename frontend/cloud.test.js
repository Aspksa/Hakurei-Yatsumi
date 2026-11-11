import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudService } from './cloud.js';

test('Cloud.ru key stays private in status and model list loads dynamically', async () => {
  const requests = [];
  const cloud = createCloudService({ fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'example/model-b' }, { id: 'example/model-a' }] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Привет!' } }] }), { status: 200 });
  } });
  cloud.setKey('supersecret');
  assert.equal(JSON.stringify(cloud.status()).includes('supersecret'), false);
  const models = await cloud.listModels();
  assert.deepEqual(models.map(m => m.id), ['example/model-a', 'example/model-b']);
  await cloud.connect('example/model-a');
  assert.equal(cloud.status().connected, true);
  const response = await cloud.chat([{ role: 'user', content: 'Привет' }]);
  assert.equal(response.content, 'Привет!');
  assert.equal(requests[0].url, 'https://foundation-models.api.cloud.ru/v1/models');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer supersecret');
  assert.equal(requests.at(-1).url, 'https://foundation-models.api.cloud.ru/v1/chat/completions');
  assert.equal(JSON.stringify(cloud.status()).includes('supersecret'), false);
  cloud.clear();
  assert.equal(cloud.status().configured, false);
});
test('Cloud.ru rejects invalid models and malformed messages', async () => {
  const cloud = createCloudService({ fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'model' }] } : { choices: [{ message: { content: 'готово' } }] }), { status: 200 }) });
  assert.throws(() => cloud.setKey('short'), /ключ/);
  cloud.setKey('valid-secret-key');
  await cloud.listModels();
  await assert.rejects(cloud.connect('unknown'), /Выберите модель/);
  await cloud.connect('model');
  await assert.rejects(cloud.chat([{ role: 'system', content: 'unsafe' }]), /история/);
});
test('Cloud.ru marks connection red after API failure', async () => {
  let fail = false;
  const cloud = createCloudService({ fetchImpl: async () => fail ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ data: [{ id: 'model' }], choices: [{ message: { content: 'готово' } }] }), { status: 200 }) });
  cloud.setKey('valid-secret-key');
  await cloud.listModels();
  await cloud.connect('model');
  fail = true;
  await assert.rejects(cloud.listModels(), /недействителен/);
  assert.equal(cloud.status().connected, false);
});

test('HTTP failures expose safe classifications without credentials', async () => {
  const codes = [400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504];
  for (const code of codes) {
    const cloud = createCloudService({ fetchImpl: async () => new Response('secret upstream error', { status: code }), sleep: async () => {} });
    cloud.setKey('private-secret-key');
    await assert.rejects(cloud.listModels(), error => {
      assert.equal(error.code, 'HTTP_' + code);
      assert.equal(error.httpStatus, code);
      assert.doesNotMatch(error.message, /private-secret-key|secret upstream/);
      return true;
    });
  }
});
test('network and malformed JSON produce diagnostic codes', async () => {
  const cloud = createCloudService({ fetchImpl: async () => { const error = new TypeError('fetch failed'); error.cause = { code: 'ENOTFOUND' }; throw error; }, sleep: async () => {} });
  cloud.setKey('private-secret-key');
  await assert.rejects(cloud.listModels(), error => error.code === 'ENOTFOUND');
  const malformed = createCloudService({ fetchImpl: async () => new Response('{bad json') });
  malformed.setKey('private-secret-key');
  await assert.rejects(malformed.listModels(), error => error.code === 'INVALID_JSON');
});
test('temporary chat failure keeps confirmed model and reports error', async () => {
  let failed = false;
  const cloud = createCloudService({ fetchImpl: async url => {
    if (failed) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'chat-model' }, { id: 'embedding-model' }] } : { choices: [{ message: { content: 'готово' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }), { status: 200 });
  } });
  cloud.setKey('private-secret-key');
  assert.deepEqual((await cloud.listModels()).map(m => m.id), ['chat-model']);
  await cloud.connect('chat-model');
  assert.equal(cloud.status().usage.total_tokens, 5);
  failed = true;
  await assert.rejects(cloud.chat([{ role: 'user', content: 'Привет' }]), error => error.code === 'HTTP_503');
  assert.equal(cloud.status().connected, true);
});
test('model list GET retries rate limit with Retry-After', async () => {
  let calls = 0;
  const sleeps = [];
  const cloud = createCloudService({ fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } }) : new Response('{"data":[{"id":"chat-model"}]}');
  }, sleep: async ms => sleeps.push(ms) });
  cloud.setKey('private-secret-key');
  assert.equal((await cloud.listModels()).length, 1);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
});

test('Cloud.ru streams SSE deltas and completion without duplicate POST', async () => {
  const encoder = new TextEncoder();
  let posts = 0;
  const cloud = createCloudService({ fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return new Response('{"data":[{"id":"chat-model"}]}');
    if (!JSON.parse(options.body).stream) return new Response('{"choices":[{"message":{"content":"готово"}}]}');
    posts++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"При"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"вет"}}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  cloud.setKey('private-secret-key');
  await cloud.listModels();
  await cloud.connect('chat-model');
  const events = [];
  await cloud.streamChat([{ role: 'user', content: 'Привет' }], event => events.push(event));
  assert.deepEqual(events.map(event => event.type), ['delta', 'delta', 'done']);
  assert.equal(events.slice(0, 2).map(event => event.content).join(''), 'Привет');
  assert.equal(posts, 1);
});
