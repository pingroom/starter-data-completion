# PingRoom data completion starter

Fill a missing catalog category by asking a person on their phone. They choose **Office supplies**, **Electronics**, or **Apparel**, or type a custom category slug. The script writes a validated JSON copy with answer provenance and leaves the source file unchanged.

This is a data-entry step: the person supplies missing information. It does not approve or execute an action.

## Try it offline

Requires Node.js 22 or newer.

```sh
npm ci
npm run demo
npm test
```

The demo uses the real `@pingroom/sdk` with an in-memory HTTP transport. It exercises both button and typed answers, then reruns each job to verify the saved output is reused. It reads no credentials, makes no network requests, and removes its temporary files.

## Connect and run

1. Install [PingRoom](https://pingroom.io/i) and sign in.
2. Run `npm run connect` and open the printed pairing link. Approve the connection and choose a private room. The connection needs `questions:ask` and access to that room.
3. Edit `record.json`, keeping `category` as `null`. Give each import a stable, unique `jobId`.
4. Run `npm start`, then answer the question on your phone.

```json
{
  "jobId": "catalog-import-001",
  "record": {
    "id": "NOTE-A5",
    "name": "A5 lined notebook, pack of three",
    "category": null
  }
}
```

A valid answer creates `output/catalog-import-001.json`. Its `record.category` contains the selected value or typed slug; `provenance` includes the source hash, question ID, answer type, responder ID when available, and server answer time. An expired, cancelled, pending, or invalid answer creates no enriched record.

`npm run connect` stores credentials in ignored `.pingroom/credentials.json`. Directories use mode `0700` and files `0600` on POSIX systems; check equivalent access controls on Windows. State and output also contain your record data, so keep them private.

Optionally copy `.env.example` to `.env`. Existing shell variables take precedence over `.env`. If either `PINGROOM_TOKEN` or `PINGROOM_ROOM` is present, **both must be nonblank**; saved credentials are used only when neither is present. Room codes are normalized to uppercase. `INPUT_FILE`, `STATE_DIR`, `OUTPUT_DIR`, and `RUN_BUDGET_MS` configure local paths and runtime.

## Resume and recover

Run `npm start` again with the same job, input, room, and connection to resume its saved question. A completed job reuses its result without another API call. Output publication is atomic and refuses to overwrite different contents; after an output conflict, move the conflicting file and rerun.

Before creating a question, the script saves its exact request and idempotency key. If creation times out or the response is lost, it reports `create_unknown` and **does not automatically send again**. Inspect recent questions using the read-only command:

```sh
npm run find-id
npm start -- --attach-id QUESTION_ID
```

Attach the question matching this import. The script checks its ID, room, prompt, context, options, text policy, correlation, input hash, and direct responder scope before accepting any answer. The recent list may omit older questions; no match is not proof that creation failed. Keep the state and investigate the remote question before deciding to start another import. A crash between creation and saving the returned ID needs the same recovery. This starter does not guarantee exactly-once delivery or permanent server idempotency-key retention.

The default run budget is 60 seconds, while the server question remains open for 15 minutes. Ctrl+C or budget expiry leaves a pending question resumable; it does not cancel it. SDK creation and read requests have a five-second timeout and cannot be interrupted in this SDK version, so a process may take up to five additional seconds to exit. Wait requests use an abort signal and start at least 2.1 seconds apart, including across restarts. Server state decides expiry; the local clock never manufactures an answer or expiration.

A lock allows one process per state directory. After a crash, first confirm no process is using that directory, then remove its `.lock` file and resume. Never delete a job's JSON file to retry an uncertain send. The starter permits 100 saved jobs per directory; archive completed state and corresponding output deliberately, preserving the history needed to avoid replaying an old job. Corrupt state stops processing and needs a valid backup.

Exit codes: `0` completed; `2` expired, cancelled, or invalid answer; `3` pending or stopped; `4` uncertain creation; `1` configuration, storage, or API failure.

## Adapt it

`src/completion.js` contains the reusable `completeRecord` function and deterministic validation. Change the three options, question wording, and output schema for another missing field. A model may propose the input record upstream; application code still validates the input and human answer. No AI provider is required.

This example accepts a small schema. IDs use letters, digits, `_`, and `-` (up to 64 characters); names use 1–120 printable ASCII characters without leading or trailing spaces. Custom categories match `^[a-z][a-z0-9_-]{0,31}$`. ASCII avoids differences between JavaScript and server Unicode trimming. Unicode or richer records need an explicit normalization policy and corresponding response checks. Input files are limited to 16 KiB. Filled categories are rejected rather than changed.

Each saved job binds the input, room, connection, and answer policy. Changing any of these requires a new job ID for new work; preserve the original configuration to resume existing work. Answer buttons and typed text are mutually exclusive. Under `responder_scope: direct`, the first answer resolves the question. If a typed category fails local validation, the job ends with `invalid_answer` and creates no output.

The SDK is pinned to `0.6.0` with a lockfile. CI runs the credential-free tests and demo on Node.js 22 and 24. See the [SDK](https://github.com/pingroom/sdk) for the API, [human review starter](https://github.com/pingroom/starter-human-review) for approval gates, and [handoff receipts](https://github.com/pingroom/starter-handoff-receipts) for tracking receipt of a message.

MIT licensed.
