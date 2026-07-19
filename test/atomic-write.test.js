import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { atomicWriteFile, atomicWriteJson } from '../src/atomic-write.js';

test('atomicWriteFile and atomicWriteJson replace the target without leaving temps', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const file = path.join(root, 'state.json');
  await atomicWriteJson(file, { version: 1, ok: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, ok: true });

  await atomicWriteFile(file, 'plain\n', { extension: '.part' });
  assert.equal(await readFile(file, 'utf8'), 'plain\n');

  const leftover = (await import('node:fs/promises')).readdir(root);
  assert.deepEqual((await leftover).filter((name) => name !== 'state.json'), []);
});
