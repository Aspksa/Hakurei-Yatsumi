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
  const cloud = createCloudService({ fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'model' }] }), { status: 200 }) });
  assert.throws(() => cloud.setKey('short'), /ключ/);
  cloud.setKey('valid-secret-key');
  await cloud.listModels();
  await assert.rejects(cloud.connect('unknown'), /Выберите модель/);
  await cloud.connect('model');
  await assert.rejects(cloud.chat([{ role: 'system', content: 'unsafe' }]), /история/);
});
test('Cloud.ru marks connection red after API failure', async () => {
  let fail = false;
  const cloud = createCloudService({ fetchImpl: async () => fail ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ data: [{ id: 'model' }] }), { status: 200 }) });
  cloud.setKey('valid-secret-key');
  await cloud.listModels();
  await cloud.connect('model');
  fail = true;
  await assert.rejects(cloud.listModels(), /отклонён/);
  assert.equal(cloud.status().connected, false);
});
