import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';

const MAX_BYTES = 10 * 1024 * 1024;
const formats = [
  { type: 'image/png', ext: 'png', match: b => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
  { type: 'image/jpeg', ext: 'jpg', match: b => b.length > 3 && b[0] === 255 && b[1] === 216 && b[2] === 255 },
  { type: 'image/webp', ext: 'webp', match: b => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' }
];
export function avatarRouter({ directory }) {
  const router = express.Router();
  const path = join(directory, 'avatar.bin');
  router.get('/avatar', async (_req, res) => {
    try {
      const bytes = await readFile(path);
      const type = formats.find(f => f.match(bytes))?.type;
      if (!type) return res.status(500).json({ error: 'Повреждённый аватар' });
      res.setHeader('content-type', type);
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      return res.end(bytes);
    } catch (error) {
      return res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: 'Аватар не найден' });
    }
  });
  router.put('/avatar', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: MAX_BYTES }), async (req, res) => {
    const bytes = req.body;
    const format = formats.find(f => f.type === req.get('content-type')?.split(';')[0] && Buffer.isBuffer(bytes) && bytes.length > 0 && f.match(bytes));
    if (!format) return res.status(415).json({ error: 'Нужен корректный PNG, JPEG или WebP' });
    await mkdir(directory, { recursive: true });
    const tmp = join(directory, '.' + randomUUID() + '.tmp');
    try {
      await writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
      await rename(tmp, path);
      res.json({ ok: true, type: format.type, size: bytes.length });
    } catch {
      res.status(500).json({ error: 'Не удалось сохранить аватар' });
    } finally { await rm(tmp, { force: true }).catch(() => {}); }
  });
  router.delete('/avatar', async (_req, res) => {
    try {
      await rm(path, { force: true });
      res.json({ ok: true });
    } catch { res.status(500).json({ error: 'Не удалось удалить аватар' }); }
  });
  return router;
}
