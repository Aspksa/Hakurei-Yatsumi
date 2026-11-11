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
    else if (path === '/conversations/42/messages') result = { id: 1 };
    else result = [];
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const core = createYatsumiCore({ fetchImpl, apiUrl: 'http://127.0.0.1:8000', apiKey: 'local-key' });
  const prepared = await core.prepare([{ role: 'user', content: 'любимый чай' }]);
  assert.match(prepared.messages[0].content, /улун/);
  await core.save('привет', 'ответ');
  assert.equal(calls.filter(call => call.path === '/conversations/42/messages' && call.method === 'POST').length, 2);
  assert.equal(calls.filter(call => call.path === '/users').length, 1);
});
