# M3 plan — Temporal durable review workflow

Spec: PA-AI-POC-PLAN.md (M3). Stack note: a shared Temporal server already runs on localhost:7233; namespace comes from env (`pa-fhir-poc` locally, `default` for fresh clones). Never run `temporal server start-dev` here.

## Global Constraints

- TypeScript strict, ESM, Node type stripping: imports use `.ts` extensions; `erasableSyntaxOnly` — no enums/namespaces/parameter properties. `npx tsc --noEmit` clean.
- No document-specific data in `src/`. Graph test namespaces already taken: `TEST-W-`, `TEST-V-`, `TEST-R-`, `TEST-C-`. This plan uses `TEST-X-` (activities test) and `TEST-F-` (workflow test). Suite runs with `--test-concurrency=1`; every test file cleans its own namespace before() and after().
- Fail loud. Tests `node --test`, colocated. Commit per logical step, plain messages, no Co-Authored-By trailer.
- New deps: `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`, `@temporalio/testing` (dev). Latest 1.x.
- **Workflow determinism**: `src/workflow/review.workflow.ts` may import at runtime ONLY from `@temporalio/workflow`. Type-only imports (`import type`) from elsewhere are fine (erased before bundling). All graph/fs/env access lives in activities.
- Env: `src/workflow/config.ts` exports `loadTemporalConfig()` → `{ address, namespace, taskQueue }` from `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE` (mirror src/graph/config.ts exactly, including the guarded `process.loadEnvFile`; missing var → throw naming it and .env.example).

## Design (binding)

Workflow input is data, not file paths: `ReviewInput = LoadSubgraphInput` (from src/graph/write.ts) — the client maps snapshots → input; activities never read fixtures. Signal `review` carries `ReviewDecision = { decision: 'approve' | 'reject'; reviewer: string; note?: string }`.

Flow: `propose(input)` → `validate(lcdId)` → block on `condition()` for the signal (indefinitely — the block is the feature) → on approve `commit(lcdId, decision)`, on reject `compensate(lcdId, decision)`. Workflow returns `{ lcdId, outcome: 'approved' | 'rejected' }`.

Review provenance lands on the LCD node as `lastReviewDecision`, `lastReviewer`, `lastReviewNote` (null note → property absent), set by commit AND compensate. commit also `SET status = 'approved'`. compensate leaves status `draft`.

If `validate` finds an unclean graph, the workflow must fail (ApplicationFailure from the activity, non-retryable) — a reviewer should never be asked to approve a graph that failed structural validation.

## Task 1 — activities + temporal config

Files: `src/workflow/config.ts`, `src/workflow/activities.ts`, `src/workflow/activities.test.ts`.

Activities are plain exported async functions (testable without Temporal), each creating its own `Graph` via `createGraph(loadGraphConfig())` and closing it in finally:
- `propose(input: LoadSubgraphInput): Promise<void>` — `ensureConstraints` then `loadSubgraph`.
- `validate(lcdId: string): Promise<void>` — run `validateGraph`; if unclean, throw `ApplicationFailure.nonRetryable` (from `@temporalio/activity`... it re-exports from common; use `@temporalio/common`'s ApplicationFailure) with the issues JSON in the message. NOTE: validateGraph is whole-graph; filter issues to those whose detail mentions the lcdId OR that are global dupes — NO: keep whole-graph semantics (same as cli load), the message lists all issues.
- `commit(lcdId: string, decision: ReviewDecision): Promise<void>` — SET status='approved' + provenance props; throw if the LCD does not exist (match count 0 → error naming lcdId).
- `compensate(lcdId: string, decision: ReviewDecision): Promise<void>` — provenance props only; status untouched; same not-found throw.
- `ReviewDecision` type lives in `src/types.ts`.

Tests (integration, `TEST-X-` namespace): propose loads the subgraph; validate passes on clean fixture; validate throws naming an injected orphan; commit flips status and writes provenance; compensate leaves draft and writes provenance; commit on missing LCD throws.

## Task 2 — workflow + worker + client

Files: `src/workflow/review.workflow.ts`, `src/workflow/worker.ts`, `src/workflow/client.ts`, `src/workflow/review.workflow.test.ts`.

- `review.workflow.ts`: `export const reviewSignal = defineSignal<[ReviewDecision]>('review');` and `export async function reviewLcd(input: ReviewInput)`. proxyActivities with `startToCloseTimeout: '1 minute'`. setHandler stores the decision; `await condition(() => decision !== undefined)` — NO timeout race; the indefinite block is the point.
- `worker.ts`: `runWorker()` — NativeConnection.connect({ address }), Worker.create({ connection, namespace, taskQueue, workflowsPath: new URL('./review.workflow.ts', import.meta.url) → fileURLToPath, activities }), `worker.run()`. Executable directly (`node src/workflow/worker.ts`) via an `if (process.argv[1] === fileURLToPath(import.meta.url))` guard printing "worker polling <taskQueue> on <namespace>" to stderr.
- `client.ts`: `startReview(input: ReviewInput): Promise<string>` (returns workflowId `review-<lcdId>`, WorkflowIdReusePolicy default), `signalReview(workflowId: string, decision: ReviewDecision): Promise<void>`, both over `Connection.connect({ address })` + `new Client({ connection, namespace })`, closing the connection in finally.
- Test with `TestWorkflowEnvironment.createLocal()` (NOT createTimeSkipping — unsupported on Apple Silicon) in before(), teardown in after(). Worker from `testEnv.nativeConnection` with the REAL activities (dockerized Neo4j behind them), task queue 'test', `TEST-F-` fixtures. Three tests: (1) started workflow is blocked — after propose/validate complete, `describe()` shows status RUNNING and LCD is still draft; (2) approve path: signal → result `{ outcome: 'approved' }` → LCD.status 'approved' + provenance in graph; (3) reject path → `{ outcome: 'rejected' }` → status 'draft', provenance recorded. Use `worker.runUntil(...)` around each execute+signal choreography; signal via `testEnv.client.workflow.getHandle(...)`.
- First `Worker.create` bundles the workflow with webpack — allow generous test time; do not add `--test-timeout`.

## Task 3 — cli verbs

Files: `cli.ts`, `test/cli-review.test.ts`.

- `node cli.ts review-start <lcdId> [articleId]` — reuse the existing snapshot-reading helpers (readExtractedSnapshot/readArticleSnapshot already in cli.ts) to build ReviewInput, call `startReview`, print the workflowId to stdout with a hint on stderr: how to run the worker and send the signal.
- `node cli.ts review-signal <workflowId> <approve|reject> <reviewer> [note]` — validate decision is approve|reject (else usage error), call `signalReview`.
- Test (`TEST-C3-` ids, temp cwd like test/cli-load.test.ts, env passthrough incl. TEMPORAL_*): review-start prints a workflow id and the workflow exists on the server (verify via a Client `describe` from the test, then `terminate` in cleanup); review-signal against the running (worker-less) workflow succeeds; review-start with missing snapshot exits 1 with the extract hint; review-signal with a bogus decision exits 1 naming the allowed values. No worker is run — nothing progresses; that is fine for these assertions.
