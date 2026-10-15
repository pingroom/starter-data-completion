import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeRecord, validateInput } from '../src/completion.js';
import { createOfflineClient, sampleInput } from '../src/offline.js';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'completion-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const offline = createOfflineClient(options);
  const args = { client: offline.client, token: 'offline-token', room: 'DEMO', input: sampleInput,
    directory: join(root, 'state'), outputDirectory: join(root, 'output'), budgetMs: 5000 };
  return { ...offline, args, root, run: (changes = {}) => completeRecord({ ...args, ...changes }),
    posts: () => offline.calls.filter((call) => call.method === 'POST'),
    saved: async () => {
      const name = (await readdir(args.directory)).find((file) => file.endsWith('.json'));
      const path = join(args.directory, name);
      return { path, state: JSON.parse(await readFile(path, 'utf8')) };
    },
    noOutput: async () => assert.deepEqual(await readdir(args.outputDirectory).catch(() => []), []),
  };
}

test('button answer writes a new record and provenance; completed rerun is local and byte-identical', async (t) => {
  const f = await setup(t);
  const result = await f.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.output.record.category, 'office_supplies');
  assert.equal(result.output.provenance.answerType, 'option');
  assert.equal(result.output.provenance.questionId, 'offline-question');
  assert.equal(result.output.provenance.sourceHash.length, 64);
  assert.equal(sampleInput.record.category, null);
  const bytes = await readFile(result.outputPath, 'utf8');
  const count = f.calls.length;
  assert.equal((await f.run()).status, 'completed');
  assert.equal(f.calls.length, count);
  assert.equal(await readFile(result.outputPath, 'utf8'), bytes);
  assert.equal(f.posts().length, 1);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.args.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(result.outputPath)).mode & 0o777, 0o600);
    assert.equal((await stat(result.statePath)).mode & 0o777, 0o600);
  }
});

test('custom ASCII slug is accepted as data, without an execution callback', async (t) => {
  const f = await setup(t, { value: null, text: 'paper_goods-2', states: ['answered'] });
  const result = await f.run();
  assert.equal(result.output.record.category, 'paper_goods-2');
  assert.equal(result.output.provenance.answerType, 'text');
});

for (const [name, mutate] of [
  ['simultaneous button and text', (q) => { q.answer.text = 'paper'; }],
  ['unknown button', (q) => { q.answer.value = 'unknown'; }],
  ['wrong button label', (q) => { q.answer.label = 'Changed label'; }],
  ['blank custom text', (q) => { q.answer = { ...q.answer, value: null, label: null, text: '' }; }],
  ['noncanonical custom text', (q) => { q.answer = { ...q.answer, value: null, label: null, text: '\u200bpaper' }; }],
  ['custom text with a button label', (q) => { q.answer = { ...q.answer, value: null, text: 'paper' }; }],
  ['answer after server expiry', (q) => { q.answer.answered_at = new Date(Date.parse(q.expires_at) + 1).toISOString(); }],
  ['missing answer time', (q) => { delete q.answer.answered_at; }],
]) {
  test(`${name} produces no enriched record`, async (t) => {
    const f = await setup(t, { states: ['answered'], onRead: (q) => { mutate(q); return q; } });
    assert.equal((await f.run()).status, 'invalid_answer');
    await f.noOutput();
  });
}

for (const [name, mutate] of [
  ['question ID', (q) => { q.id = 'some-other-question'; }],
  ['prompt', (q) => { q.prompt += ' Different'; }],
  ['context', (q) => { q.context += ' Different'; }],
  ['option policy', (q) => { q.options[0].value = 'wrong_category'; }],
  ['text policy', (q) => { q.text_input.max_length = 60; }],
  ['source hash', (q) => { q.data.source_hash = 'different'; }],
  ['responder scope', (q) => { q.responder_scope = 'room'; }],
  ['room', (q) => { q.room_code = 'OTHER'; }],
  ['correlation', (q) => { q.correlation_id = 'other-job'; }],
]) {
  test(`mismatched ${name} is rejected before output`, async (t) => {
    const f = await setup(t, { states: ['answered'], onRead: (q) => { mutate(q); return q; } });
    await assert.rejects(f.run(), { code: 'question_mismatch' });
    await f.noOutput();
  });
}

for (const state of ['expired', 'cancelled']) {
  test(`authoritative ${state} is saved without output or another send`, async (t) => {
    const f = await setup(t, { states: [state] });
    assert.equal((await f.run()).status, state);
    const count = f.calls.length;
    assert.equal((await f.run()).status, state);
    assert.equal(f.calls.length, count);
    await f.noOutput();
  });
}

test('request and idempotency key are durable before create; uncertain send is not automatically retried', async (t) => {
  let f;
  f = await setup(t, { onCreate: async (q) => {
    const { state } = await f.saved();
    assert.equal(state.phase, 'prepared');
    assert.equal(state.questionId, null);
    assert.equal(state.request.prompt, q.prompt);
    assert.equal(new Headers(f.posts()[0].headers).get('Idempotency-Key'), state.key);
    throw new Error('Simulated connection lost after server accepted request.');
  } });
  assert.equal((await f.run()).status, 'create_unknown');
  const before = await f.saved();
  assert.equal((await f.run()).status, 'create_unknown');
  assert.deepEqual((await f.saved()).state, before.state);
  assert.equal(f.posts().length, 1);
  await f.noOutput();
  const recovered = await f.run({ attachId: 'offline-question' });
  assert.equal(recovered.status, 'completed');
  assert.equal(f.posts().length, 1);
});

test('unknown create cannot attach an unrelated question', async (t) => {
  const f = await setup(t, { createError: new Error('Lost reply'), states: ['answered'],
    onRead: (q) => ({ ...q, context: 'Unrelated import' }) });
  assert.equal((await f.run()).status, 'create_unknown');
  await assert.rejects(f.run({ attachId: 'offline-question' }), { code: 'question_mismatch' });
  assert.equal((await f.saved()).state.phase, 'prepared');
  await f.noOutput();
});

test('run budget leaves a pending question resumable without another create', async (t) => {
  const f = await setup(t, { states: ['pending'] });
  const result = await f.run({ budgetMs: 1000 });
  assert.equal(result.status, 'pending');
  assert.equal(result.questionId, 'offline-question');
  await f.noOutput();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { assert.equal((await f.run({ signal: controller.signal })).status, 'pending'); }
  finally { clearTimeout(timer); }
  assert.equal(f.posts().length, 1);
});

test('abort during a get preserves the known ID and a later answer can complete it', async (t) => {
  const controller = new AbortController();
  let first = true;
  const f = await setup(t, { states: ['answered'], onRead: async (q) => {
    if (first) { first = false; controller.abort(); }
    return q;
  } });
  assert.equal((await f.run({ signal: controller.signal })).status, 'pending');
  await f.noOutput();
  assert.equal((await f.run()).status, 'completed');
  assert.equal(f.posts().length, 1);
});

test('pre-aborted run creates neither state nor remote question', async (t) => {
  const f = await setup(t);
  assert.equal((await f.run({ signal: AbortSignal.abort() })).status, 'stopped');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.root), []);
});

test('immediate pending replies are paced and saved across runs', async (t) => {
  const times = [];
  const controller = new AbortController();
  const f = await setup(t, { states: ['pending'], onWait: (q) => {
    times.push(Date.now());
    if (times.length === 2) controller.abort();
    return q;
  } });
  assert.equal((await f.run({ signal: controller.signal })).status, 'pending');
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 2000);
  assert.ok((await f.saved()).state.lastWaitStarted >= times[0]);
});

test('same job refuses changed source, room, or connection without another request', async (t) => {
  const f = await setup(t, { states: ['answered'] });
  await f.run();
  const count = f.calls.length;
  for (const changes of [
    { input: { ...sampleInput, record: { ...sampleInput.record, name: 'Different item' } } },
    { room: 'OTHER' }, { token: 'other-token' },
  ]) await assert.rejects(f.run(changes), { code: 'binding_mismatch' });
  assert.equal(f.calls.length, count);
});

test('corrupt local state never silently starts over', async (t) => {
  const f = await setup(t, { createError: new Error('Lost reply') });
  await f.run();
  const { path, state } = await f.saved();
  for (const value of ['null', '{broken', JSON.stringify({ ...state, key: 'changed' })]) {
    await writeFile(path, value);
    await assert.rejects(f.run(), /Invalid/i);
  }
  assert.equal(f.posts().length, 1);
});

test('output conflict is preserved and recovering after it is moved does not send again', async (t) => {
  const f = await setup(t, { states: ['answered'] });
  await mkdir(f.args.outputDirectory);
  const outputPath = join(f.args.outputDirectory, `${sampleInput.jobId}.json`);
  await writeFile(outputPath, 'existing import data');
  await assert.rejects(f.run(), /not overwritten/);
  assert.equal(await readFile(outputPath, 'utf8'), 'existing import data');
  await rm(outputPath);
  assert.equal((await f.run()).status, 'completed');
  assert.equal(f.posts().length, 1);
});

test('concurrent process lock prevents two creates', async (t) => {
  let release, started;
  const created = new Promise((resolve) => { started = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const f = await setup(t, { states: ['answered'], onCreate: async (q) => { started(); await barrier; return q; } });
  const first = f.run();
  await created;
  try { await assert.rejects(f.run(), /locked/); }
  finally { release(); }
  assert.equal((await first).status, 'completed');
  assert.equal(f.posts().length, 1);
});

test('input rejects hidden Unicode, ambiguous names, extra keys, and populated categories', () => {
  for (const record of [
    { ...sampleInput.record, name: '\u200bNotebook' },
    { ...sampleInput.record, name: ' Notebook' },
    { ...sampleInput.record, name: 'Note\nbook' },
    { ...sampleInput.record, category: 'apparel' },
    { ...sampleInput.record, execute: 'anything' },
  ]) assert.throws(() => validateInput({ ...sampleInput, record }), { code: 'invalid_input' });
});
