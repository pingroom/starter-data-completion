import { PingRoom } from '@pingroom/sdk';
import { loadConfig, loadEnv } from './config.js';

try {
  loadEnv();
  const { token, input, room } = await loadConfig();
  const client = new PingRoom({ token, timeoutMs: 5000 });
  const questions = await client.questions.list({ state: 'all' });
  for (const q of questions) {
    if (q.data?.job_id === input.jobId && (q.room_code ?? q.room?.code)?.toUpperCase() === room) console.log(`Candidate Question: ${q.id}`);
  }
  console.log('Read-only search of recent Questions. No match does not prove creation failed. --attach-id validates the full saved request.');
} catch {
  console.error('Could not read Questions. Check the connection and questions:ask scope.');
  process.exitCode = 1;
}
