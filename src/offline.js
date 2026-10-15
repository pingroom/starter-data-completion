import { PingRoom } from '@pingroom/sdk';

export const sampleInput = Object.freeze({ jobId: 'example-import', record: Object.freeze({ id: 'NOTE-A5', name: 'A5 lined notebook', category: null }) });
const labels = { office_supplies: 'Office supplies', electronics: 'Electronics', apparel: 'Apparel' };

/** Real SDK, injected HTTP transport, no network calls or credential reads. */
export function createOfflineClient({ value = 'office_supplies', text = null, states = ['pending', 'answered'], onCreate, onRead, onWait, createError } = {}) {
  const calls = [];
  let question, position = 0;
  const snapshot = () => {
    const state = states[Math.min(position++, states.length - 1)];
    return { ...question, state, resolved_at: state === 'pending' ? null : new Date().toISOString(),
      answer: state === 'answered' ? { value, label: value === null ? null : labels[value] ?? value, text, responder: { id: 'offline-human', display_name: 'Example person' }, answered_at: new Date().toISOString() } : null };
  };
  const client = new PingRoom({ token: 'offline-token', baseUrl: 'https://completion-demo.invalid', timeoutMs: 5000,
    fetch: async (url, init) => {
      const target = new URL(url);
      if (target.origin !== 'https://completion-demo.invalid') throw new Error('Unexpected offline origin.');
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ method: init.method, path: target.pathname, body, headers: init.headers });
      let response;
      if (init.method === 'POST' && target.pathname === '/api/agent/rooms/DEMO/questions') {
        question = { ...body, id: 'offline-question', kind: 'question', state: 'pending', answer: null,
          target_user_id: 'offline-human', resolution_policy: 'first', room: { code: 'DEMO', name: 'Demo' }, room_code: 'DEMO',
          created_at: new Date().toISOString(), expires_at: new Date(Date.now() + body.ttl * 1000).toISOString(), resolved_at: null, reply_to: null };
        if (createError) throw createError;
        response = onCreate ? await onCreate(structuredClone(question), init.signal) : question;
      } else if (init.method === 'GET' && target.pathname === '/api/agent/questions/offline-question' && question) {
        response = snapshot(); if (onRead) response = await onRead(response, init.signal);
      } else if (init.method === 'GET' && target.pathname === '/api/agent/questions/offline-question/wait' && question) {
        response = snapshot(); if (onWait) response = await onWait(response, init.signal);
      } else if (init.method === 'GET' && target.pathname === '/api/agent/questions') {
        response = { questions: question ? [snapshot()] : [] };
      } else throw new Error('Unexpected offline request.');
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
    },
  });
  return { client, calls };
}
