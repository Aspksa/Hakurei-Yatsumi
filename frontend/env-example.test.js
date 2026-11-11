import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('.env.example documents every environment variable the code reads', async () => {
  const sources = await Promise.all(['frontend/server.js', 'backend/app/main.py', 'backend/app/db.py'].map(read));
  const used = new Set(sources.join('\n').match(/\b(?:YATSUMI_[A-Z_]+|PYTHON_API_URL)\b/g));
  const documented = new Set((await read('.env.example')).match(/^[A-Z_]+(?==)/gm));
  const missing = [...used].filter(name => !documented.has(name));
  assert.deepEqual(missing, [], 'Add to .env.example: ' + missing.join(', '));
});
