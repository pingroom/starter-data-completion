import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { openState, publishOutput } from './storage.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const isoDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
const questionId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,255}$/.test(value);
const slug = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const OPTIONS = Object.freeze([
  Object.freeze({ value: 'office_supplies', label: 'Office supplies' }),
  Object.freeze({ value: 'electronics', label: 'Electronics' }),
  Object.freeze({ value: 'apparel', label: 'Apparel' }),
]);
const TEXT_INPUT = Object.freeze({ placeholder: 'Custom category: lower_case_slug', max_length: 32 });
const TTL = 900;

export class CompletionError extends Error {
  constructor(code, message) { super(message); this.name = 'CompletionError'; this.code = code; }
}

export function validateInput(input) {
  const record = input?.record;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'jobId,record'
    || !id(input.jobId) || !record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).sort().join(',') !== 'category,id,name' || !id(record.id)
    || typeof record.name !== 'string' || !/^[\x20-\x7e]{1,120}$/.test(record.name)
    || record.name.trim() !== record.name || record.category !== null) {
    throw new CompletionError('invalid_input', 'Expected jobId and record {id,name,category:null}; IDs use letters/digits/_/-, and name is 1–120 printable ASCII characters without edge spaces.');
  }
  return Object.freeze({ jobId: input.jobId, record: Object.freeze({ id: record.id, name: record.name, category: null }) });
}

function makeRequest(input, sourceHash, key) {
  return {
    prompt: `Choose a category for ${input.record.id}: ${input.record.name}. Tap a category or type a lowercase category slug.`,
    context: `Import ${sourceHash.slice(0, 16)}`,
    options: OPTIONS, text_input: TEXT_INPUT, responder_scope: 'direct', ttl: TTL,
    correlation_id: `completion-${key}`, data: { job_id: input.jobId, source_hash: sourceHash },
    idempotencyKey: key,
  };
}

function bounded(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

function assertQuestion(q, request, expectedId, room) {
  const code = q?.room_code ?? q?.room?.code;
  if (!questionId(q?.id) || q.id !== expectedId || q.kind !== 'question'
    || q.prompt !== request.prompt || q.context !== request.context || q.responder_scope !== 'direct'
    || q.resolution_policy !== 'first' || q.correlation_id !== request.correlation_id
    || q.data?.source_hash !== request.data.source_hash || q.data?.job_id !== request.data.job_id
    || q.text_input?.placeholder !== TEXT_INPUT.placeholder || q.text_input?.max_length !== 32
    || !Array.isArray(q.options) || q.options.length !== 3
    || q.options.some((option, index) => option.value !== OPTIONS[index].value || option.label !== OPTIONS[index].label)
    || typeof code !== 'string' || code.toUpperCase() !== room
    || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !isoDate(q.created_at) || !isoDate(q.expires_at)) {
    throw new CompletionError('question_mismatch', 'The returned Question does not match the saved input, room, or answer policy.');
  }
}

function resolveAnswer(q) {
  const answer = q.answer;
  if (!answer || !isoDate(answer.answered_at)
    || Date.parse(answer.answered_at) < Date.parse(q.created_at)
    || Date.parse(answer.answered_at) > Date.parse(q.expires_at)) return { state: 'invalid_answer' };
  const selected = OPTIONS.find((option) => option.value === answer.value);
  let category, answerType;
  if (selected && answer.label === selected.label && answer.text === null) {
    category = selected.value; answerType = 'option';
  } else if (answer.value === null && answer.label === null && slug(answer.text)) {
    category = answer.text; answerType = 'text';
  } else return { state: 'invalid_answer' };
  return { state: 'answered', category, answerType, answeredAt: answer.answered_at,
    responderId: typeof answer.responder?.id === 'string' ? answer.responder.id : null };
}

function validateSaved(state, binding, input, sourceHash) {
  if (state.binding !== binding) throw new CompletionError('binding_mismatch', 'This job ID belongs to different input, room, connection, or answer policy. Restore the original configuration or use a new job ID for new work.');
  if (state.version !== 1 || state.jobId !== input.jobId || !isoDate(state.createdAt)
    || typeof state.key !== 'string' || !/^completion-[a-f0-9-]{36}$/.test(state.key)
    || !['prepared', 'waiting', 'finished'].includes(state.phase)
    || !Number.isSafeInteger(state.lastWaitStarted) || state.lastWaitStarted < 0
    || (state.phase === 'prepared' ? state.questionId !== null : !questionId(state.questionId))
    || JSON.stringify(state.request) !== JSON.stringify(makeRequest(input, sourceHash, state.key))) {
    throw new CompletionError('invalid_state', 'Invalid local state. Restore a valid backup before continuing.');
  }
  if (state.phase === 'finished') {
    const value = state.result;
    if (!value || !['answered', 'expired', 'cancelled', 'invalid_answer'].includes(value.state)
      || (value.state === 'answered' && (!slug(value.category) || !['text', 'option'].includes(value.answerType)
        || !isoDate(value.answeredAt) || (value.answerType === 'option' && !OPTIONS.some((option) => option.value === value.category))))) {
      throw new CompletionError('invalid_state', 'Invalid saved answer. Restore a valid backup.');
    }
  }
}

/** Complete one missing category. This function never runs an action handler. */
export async function completeRecord({ client, token, room, input: rawInput, directory, outputDirectory, budgetMs = 60_000, signal, attachId }) {
  const input = validateInput(rawInput);
  if (typeof token !== 'string' || !token.trim() || typeof room !== 'string' || !room.trim()) throw new CompletionError('invalid_connection', 'Provide a complete PingRoom connection.');
  room = room.trim().toUpperCase();
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 3_600_000) throw new CompletionError('invalid_budget', 'Budget must be 1–3600000 milliseconds.');
  if (attachId !== undefined && !questionId(attachId)) throw new CompletionError('invalid_id', 'Invalid Question ID.');
  const sourceHash = hash(JSON.stringify(input));
  const binding = hash(JSON.stringify({ sourceHash, room, credentialHash: hash(token), options: OPTIONS, text: TEXT_INPUT, ttl: TTL }));
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('stopped'));
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop, { once: true });
  const deadline = Date.now() + budgetMs;
  const timer = setTimeout(stop, budgetMs);
  let store, state;
  const outcome = (status) => ({ status, questionId: state?.questionId ?? null, statePath: store?.path });
  const finish = async () => {
    if (state.result.state !== 'answered') return outcome(state.result.state);
    const { category, answerType, answeredAt, responderId } = state.result;
    const output = { record: { ...input.record, category }, provenance: { jobId: input.jobId, sourceHash, questionId: state.questionId, answerType, answeredAt, responderId } };
    const outputPath = await publishOutput(outputDirectory, `${input.jobId}.json`, output);
    return { ...outcome('completed'), outputPath, output };
  };
  try {
    controller.signal.throwIfAborted();
    store = await openState(directory, hash(input.jobId));
    state = await store.read();
    if (state) validateSaved(state, binding, input, sourceHash);
    if (state?.phase === 'finished') return await finish();
    if (attachId && !state) throw new CompletionError('nothing_to_recover', 'There is no uncertain Question creation to recover.');
    if (state?.questionId && attachId && state.questionId !== attachId) throw new CompletionError('already_tracking', 'This job is tracking a different Question.');
    if (!state) {
      const key = `completion-${randomUUID()}`;
      state = { version: 1, jobId: input.jobId, binding, key, request: makeRequest(input, sourceHash, key), questionId: null, phase: 'prepared', result: null, lastWaitStarted: 0, createdAt: new Date().toISOString() };
      await store.write(state);
      controller.signal.throwIfAborted();
      let created;
      try { created = await bounded(Promise.resolve().then(() => client.questions.ask(room, state.request)), controller.signal); }
      catch { return outcome('create_unknown'); }
      if (!questionId(created?.id)) return outcome('create_unknown');
      state = { ...state, phase: 'waiting', questionId: created.id };
      try { await store.write(state); }
      catch {
        const error = new CompletionError('save_failed', 'Question created but its ID could not be saved. Restore storage and attach the returned ID.');
        error.questionId = created.id; throw error;
      }
    }
    if (state.phase === 'prepared' && !attachId) return outcome('create_unknown');
    controller.signal.throwIfAborted();
    const expectedId = state.questionId ?? attachId;
    let q = await bounded(Promise.resolve().then(() => client.questions.get(expectedId)), controller.signal);
    for (;;) {
      assertQuestion(q, state.request, expectedId, room);
      state = { ...state, phase: 'waiting', questionId: expectedId };
      if (q.state !== 'pending') {
        state = { ...state, phase: 'finished', result: q.state === 'answered' ? resolveAnswer(q) : { state: q.state } };
        await store.write(state);
        return await finish();
      }
      await store.write(state);
      controller.signal.throwIfAborted();
      if (Date.now() >= deadline) return outcome('pending');
      await sleep(Math.max(0, 2100 - (Date.now() - state.lastWaitStarted)), undefined, { signal: controller.signal });
      controller.signal.throwIfAborted();
      state = { ...state, lastWaitStarted: Date.now() };
      await store.write(state);
      controller.signal.throwIfAborted();
      const timeout = Math.min(20, Math.max(0, Math.floor((deadline - Date.now()) / 1000)));
      q = await bounded(Promise.resolve().then(() => client.questions.wait(expectedId, { timeout, signal: controller.signal })), controller.signal);
    }
  } catch (error) {
    if (controller.signal.aborted) return outcome(state?.questionId ? 'pending' : state ? 'create_unknown' : 'stopped');
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', stop); await store?.close();
  }
}
