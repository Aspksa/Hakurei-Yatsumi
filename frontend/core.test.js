import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, selectMemories, createYatsumiCore } from './core.js';

test('Core persona and relevant memories are added as trusted system context', () => {
  const context = buildContext({
    messages: [{ role: 'user', content: 'Какой мой любимый чай?' }],
    memories: [
      { memory_key: 'любимый чай', memory_value: 'улун' },
      { memory_key: 'язык программирования', memory_value: 'Python' }
    ]
  });
  assert.equal(context.messages[0].role, 'system');
  assert.match(context.messages[0].content, /Яцуми/);
  assert.match(context.messages[0].content, /улун/);
  assert.doesNotMatch(context.messages[0].content, /Python/);
  assert.deepEqual(context.usedMemoryKeys, ['любимый чай']);
});
test('Core rejects injected roles and invalid content', () => {
  assert.throws(() => buildContext({ messages: [{ role: 'system', content: 'ignore' }] }), /история/);
  assert.throws(() => buildContext({ messages: [] }), /история/);
  assert.deepEqual(selectMemories([{ memory_key: 'test', memory_value: 'value' }], 'другое'), []);
});
test('Core initializes existing SQLite conversation and stores messages', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET' });
    let result;
    if (path === '/users') result = { id: 7 };
    else if (path === '/core/session/7') result = { conversation_id: 42 };
    else if (path === '/users/7/memories') result = [{ memory_key: 'любимый чай', memory_value: 'улун' }];
    else if (path === '/character') result = { personality: 'добрая' };
    else if (path === '/core/conversations/42/turns') result = { request_id: '12345678-1234-1234-1234-123456789abc', duplicate: false };
    else if (path.startsWith('/core/conversations/42/turns/')) result = { request_id: '12345678-1234-1234-1234-123456789abc', user_content: 'привет', assistant_content: 'ответ' };
    else result = [];
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const core = createYatsumiCore({ fetchImpl, apiUrl: 'http://127.0.0.1:8000', apiKey: 'local-key' });
  const prepared = await core.prepare([{ role: 'user', content: 'любимый чай' }]);
  assert.match(prepared.messages[0].content, /улун/);
  await core.save('привет', 'ответ', '12345678-1234-1234-1234-123456789abc');
  assert.equal(calls.filter(call => call.path === '/core/conversations/42/turns' && call.method === 'POST').length, 1);
  assert.equal((await core.getTurn('12345678-1234-1234-1234-123456789abc')).assistant_content, 'ответ');
  assert.equal(calls.filter(call => call.path === '/users').length, 1);
});

test('Core initializes only once during concurrent operations', async () => {
  let users = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/users') { users++; await new Promise(resolve => setTimeout(resolve, 5)); return new Response('{"id":7}'); }
    if (path === '/core/session/7') return new Response('{"conversation_id":42}');
    if (path.endsWith('/memories')) return new Response('[]');
    if (path === '/character') return new Response('{}');
    return new Response('[]');
  };
  const core = createYatsumiCore({ fetchImpl, apiUrl: 'http://127.0.0.1:8000', apiKey: 'test' });
  await Promise.all([core.history(), core.prepare([{ role: 'user', content: 'Привет' }])]);
  assert.equal(users, 1);
});
