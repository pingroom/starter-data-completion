import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials, loadConfig } from '../src/config.js';
import { sampleInput } from '../src/offline.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'completion-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'input.json');
}

test('complete environment pair bypasses even corrupt saved credentials and normalizes room', async (t) => {
  const path = await fixture(t);
  await writeFile(path, '{broken');
  assert.deepEqual(await loadCredentials({ PINGROOM_TOKEN: ' env-token ', PINGROOM_ROOM: ' room_1 ' }, path), { token: 'env-token', room: 'ROOM_1' });
});

test('partial and blank environment pairs cannot borrow saved values', async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify({ token: 'saved-token', room: 'SAVED' }));
  for (const env of [
    { PINGROOM_TOKEN: 'env-token' }, { PINGROOM_ROOM: 'ENV' },
    { PINGROOM_TOKEN: '', PINGROOM_ROOM: 'ENV' },
    { PINGROOM_TOKEN: 'env-token', PINGROOM_ROOM: ' ' },
  ]) await assert.rejects(loadCredentials(env, path), /both nonblank/);
});

test('saved credentials require valid strings and normalize room', async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify({ token: 'saved-token', room: 'demo' }));
  assert.deepEqual(await loadCredentials({}, path), { token: 'saved-token', room: 'DEMO' });
  for (const value of [null, { token: '', room: 'DEMO' }, { token: 'token', room: 123 }, { token: 'token', room: 'bad room' }]) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(loadCredentials({}, path));
  }
});

test('config reads a strict record without changing source and rejects oversized input or invalid budget', async (t) => {
  const path = await fixture(t);
  const bytes = JSON.stringify(sampleInput);
  await writeFile(path, bytes);
  const env = { PINGROOM_TOKEN: 'token', PINGROOM_ROOM: 'demo', INPUT_FILE: path, RUN_BUDGET_MS: '1000' };
  assert.deepEqual((await loadConfig(env)).input, sampleInput);
  assert.equal(await readFile(path, 'utf8'), bytes);
  await assert.rejects(loadConfig({ ...env, RUN_BUDGET_MS: '30' }), /RUN_BUDGET_MS/);
  await writeFile(path, ' '.repeat(16_385));
  await assert.rejects(loadConfig(env), /16 KiB/);
});
