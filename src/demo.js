import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { completeRecord } from './completion.js';
import { createOfflineClient, sampleInput } from './offline.js';

const root = await mkdtemp(join(tmpdir(), 'pingroom-completion-demo-'));
try {
  console.log('Offline demo: real SDK, simulated human answers, temporary local files. No network or credentials.');
  const options = { token: 'offline-token', room: 'DEMO', directory: join(root, 'state'), outputDirectory: join(root, 'output'), budgetMs: 5000 };
  for (const [jobId, answer] of [['button-answer', {}], ['typed-answer', { value: null, text: 'paper_goods' }]]) {
    const { client, calls } = createOfflineClient(answer);
    const input = { ...sampleInput, jobId };
    const result = await completeRecord({ ...options, client, input });
    const bytes = await readFile(result.outputPath, 'utf8');
    await completeRecord({ ...options, client, input });
    console.log(`${jobId}: ${result.output.record.category}; rerun reused identical output: ${bytes === await readFile(result.outputPath, 'utf8')}; Questions sent: ${calls.filter((call) => call.method === 'POST').length}.`);
  }
} finally { await rm(root, { recursive: true, force: true }); }
