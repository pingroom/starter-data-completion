import { PingRoom } from '@pingroom/sdk';
import { loadConfig, loadEnv } from './config.js';
import { completeRecord, CompletionError } from './completion.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--attach-id')) throw new CompletionError('usage', 'Usage: npm start [-- --attach-id QUESTION_ID]');
  loadEnv();
  const config = await loadConfig();
  const client = new PingRoom({ token: config.token, timeoutMs: 5000 });
  const result = await completeRecord({ ...config, client, signal: controller.signal, attachId: args[1] });
  console.log(`Import ${config.input.jobId}: ${result.status}`);
  if (result.questionId) console.log(`Question: ${result.questionId}`);
  if (result.statePath) console.log(`State: ${result.statePath}`);
  if (result.outputPath) console.log(`Enriched copy: ${result.outputPath}`);
  if (result.status === 'pending') console.log('Run npm start again with the same input to resume.');
  if (result.status === 'create_unknown') console.log('Question creation is uncertain. Use npm run find-id, then --attach-id; see README.');
  process.exitCode = { completed: 0, expired: 2, cancelled: 2, invalid_answer: 2, pending: 3, stopped: 3, create_unknown: 4 }[result.status] ?? 1;
} catch (error) {
  console.error(error instanceof CompletionError ? `${error.code}: ${error.message}` : 'Could not complete the import. Check configuration, connection, state, and output files; see README.');
  if (error instanceof CompletionError && error.questionId) console.error(`Recover Question: ${error.questionId}`);
  process.exitCode = 1;
}
