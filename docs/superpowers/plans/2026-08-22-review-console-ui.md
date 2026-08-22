# Review Console UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A localhost web UI that drives the pipeline from PDF upload through a domain-aware approve/reject review screen to downloadable FHIR artifacts.

**Architecture:** A plain Node HTTP server (`src/ui/server.ts`) serving one static HTML page plus a small JSON API, importing existing pipeline modules directly. In-memory job map for the pre-workflow phase only; Temporal (visibility list + describe + a new `reviewStatus` query) owns all workflow-phase state.

**Tech Stack:** Node ≥ 22 (`node:http`, undici `Response.formData()` for multipart — zero new dependencies), TypeScript strict ESM run unbuilt via type stripping, `node --test`, `@temporalio/client`/`@temporalio/workflow`, vanilla-JS HTML page.

**Spec:** `docs/superpowers/specs/2026-08-21-review-console-ui-design.md` — read it first; every requirement below traces to it.

## Global Constraints

- TypeScript strict, ESM, no `any` in domain types; no new npm dependencies.
- No document-specific data (LCD ids, HCPCS codes, requirement wording) in `src/` — fixtures only. Test fixture VALUES stay namespace-prefixed (`TEST-P-…` style, e.g. lcdId `TEST-L1`).
- Tests never invoke the LLM, Docker, or live Temporal/Neo4j (`@temporalio/testing` env is fine — existing precedent).
- Fail loud: no silent fallbacks, no swallowed errors, error messages actionable.
- Child processes (none expected here) would use array args, `shell: false`.
- Agents: do NOT run any `git` commands — the supervisor reviews and commits per task.
- Verify with `npx tsc --noEmit` and the task's named `node --test` file(s) before reporting done.

---

### Task 1: Hoist snapshot + projection-write helpers out of cli.ts

**Files:**
- Create: `src/extract/snapshot.ts`
- Create: `src/fhir/write.ts`
- Modify: `cli.ts` (delete the moved code, import from the new modules; behavior identical)
- Test: `test/cli-run.test.ts` must still pass unmodified (it covers the deterministic surface of these helpers)

**Interfaces:**
- Consumes: existing `extractLcd`, `extractArticle`, `LlmClient`, `readApprovedSubgraph`, `projectLcd`, `createGraph`, `loadGraphConfig`.
- Produces (later tasks rely on these exact signatures):

```ts
// src/extract/snapshot.ts
export const FIXTURES_DIR: string;
export function unionCodes(a: readonly CodeRef[], b: readonly CodeRef[]): CodeRef[];
export async function extractAndSnapshot(pdfPath: string, llm: LlmClient): Promise<ExtractionResult>;
export async function extractArticleAndSnapshot(pdfPath: string, llm: LlmClient): Promise<ArticleExtractionResult>;
export async function readExtractedSnapshot(lcdId: string): Promise</* same shape cli.ts returns today */>;
export async function readArticleSnapshot(articleId: string): Promise</* same shape cli.ts returns today */>;

// src/fhir/write.ts
export const OUT_DIR: string;
export interface ProjectedArtifacts {
  readonly paths: { readonly crd: string; readonly dtr: string; readonly planDefinition: string };
  readonly artifacts: { readonly crd: unknown; readonly dtr: unknown; readonly planDefinition: unknown };
}
export async function projectAndWrite(lcdId: string): Promise<ProjectedArtifacts>;
```

- [ ] **Step 1:** Move `FIXTURES_DIR`, `unionCodes`, `extractAndSnapshot`, `extractArticleAndSnapshot`, `readExtractedSnapshot`, `readArticleSnapshot` (cli.ts, roughly lines 40–176) verbatim into `src/extract/snapshot.ts`, with two changes only: `extractAndSnapshot`/`extractArticleAndSnapshot` take an explicit `llm: LlmClient` second parameter instead of calling `ollamaClient()` internally, and `FIXTURES_DIR` resolves relative to the repo root independent of cwd (`new URL('../../fixtures', import.meta.url)` → `fileURLToPath`). Keep the snapshot-shape validation errors word-for-word.
- [ ] **Step 2:** Move `OUT_DIR` and `projectAndWrite` (cli.ts:225-245) into `src/fhir/write.ts`; change the return from `void` to `ProjectedArtifacts` above (it already has all the values in scope). `OUT_DIR` resolves relative to repo root like `FIXTURES_DIR`.
- [ ] **Step 3:** Update `cli.ts` to import all of these; `extractAndSnapshot(pdfPath, ollamaClient())` at call sites; `runProject`/`runRun` print `paths` exactly as before. cli.ts should shrink by ~130 lines and gain no logic.
- [ ] **Step 4:** Run: `node --test test/cli-run.test.ts` → PASS unmodified; `npx tsc --noEmit` → clean.
- [ ] **Step 5:** Commit (supervisor).

### Task 2: Status-agnostic subgraph reader

**Files:**
- Modify: `src/graph/read.ts`
- Test: `src/graph/read.test.ts` (extend existing if present, else create)

**Interfaces:**
- Produces: `export async function readSubgraph(graph: Graph, lcdId: string): Promise<ApprovedSubgraph>` — identical to `readApprovedSubgraph` minus the status guard (returns a `draft` LCD fine; still throws the existing "not found in the graph" error for a missing LCD). `readApprovedSubgraph(graph, lcdId)` becomes: call `readSubgraph`, then apply the existing status-check throw verbatim. The `ApprovedSubgraph` interface name stays unchanged (its `status` field already carries `LcdStatus`); do not rename or touch `src/fhir/project.ts`.

- [ ] **Step 1:** Write failing tests using a stub `Graph` (an object with a `run` method returning canned rows, the pattern the file's existing tests use if any — otherwise a minimal `{ run: async (q, p) => ... }` keyed on query substring): (a) `readSubgraph` returns a `draft` LCD's requirements/codes; (b) `readApprovedSubgraph` still throws on `draft` with the existing message; (c) both throw the existing not-found message when no LCD row.
- [ ] **Step 2:** Run: `node --test src/graph/read.test.ts` → FAIL (`readSubgraph` not exported).
- [ ] **Step 3:** Implement the split (pure code motion + one guard relocation; no query changes).
- [ ] **Step 4:** Run: `node --test src/graph/read.test.ts` → PASS; `npx tsc --noEmit` → clean.
- [ ] **Step 5:** Commit (supervisor).

### Task 3: `reviewStatus` query handler

**Files:**
- Modify: `src/workflow/review.workflow.ts`
- Test: `src/workflow/review.workflow.test.ts` (extend the existing `@temporalio/testing` harness)

**Interfaces:**
- Produces:

```ts
export type ReviewStatus = 'proposing' | 'validating' | 'awaiting-review';
export const reviewStatusQuery = defineQuery<ReviewStatus>('reviewStatus');
```

- [ ] **Step 1:** Write a failing test in the existing harness: start `reviewLcd` with mocked activities, query `reviewStatus` → expect `'awaiting-review'` once activities have completed but before any signal; then signal approve and let it finish as today's tests do.
- [ ] **Step 2:** Run: `node --test src/workflow/review.workflow.test.ts` → FAIL (unknown query type).
- [ ] **Step 3:** Implement: `let status: ReviewStatus = 'proposing'; setHandler(reviewStatusQuery, () => status);` registered at the top of `reviewLcd` alongside the signal handler; `status = 'validating'` after `await propose(...)`; `status = 'awaiting-review'` after `await validate(...)`. Nothing else changes — a query handler emits no commands and cannot affect determinism.
- [ ] **Step 4:** Run: `node --test src/workflow/review.workflow.test.ts` → PASS (all pre-existing tests too); `npx tsc --noEmit` → clean.
- [ ] **Step 5:** Commit (supervisor).

### Task 4: Temporal client read-side helpers

**Files:**
- Modify: `src/workflow/client.ts`
- Test: `src/workflow/client.test.ts` (only for the pure bits — timeout wrapper logic via injected fakes; no live Temporal)

**Interfaces:**
- Consumes: `reviewStatusQuery`, `ReviewStatus` from Task 3.
- Produces:

```ts
export type WorkflowRuntimeStatus =
  'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TERMINATED' | 'CONTINUED_AS_NEW' | 'TIMED_OUT';
export interface ReviewWorkflowInfo { readonly workflowId: string; readonly status: WorkflowRuntimeStatus; }
export async function listReviewWorkflows(): Promise<ReviewWorkflowInfo[]>;      // visibility list, query: `WorkflowType = 'reviewLcd'`
export async function describeReview(workflowId: string): Promise<ReviewWorkflowInfo>;
export async function queryReviewStatus(workflowId: string, timeoutMs?: number): Promise<ReviewStatus | 'worker-unavailable'>; // default 2000ms
export async function getReviewResult(workflowId: string): Promise<ReviewResult>; // handle.result(); caller only invokes when COMPLETED
```

- [ ] **Step 1:** Implement, following the file's existing one-connection-per-call pattern verbatim (`Connection.connect` / `try` / `finally close`). `listReviewWorkflows` iterates `client.workflow.list({ query: "WorkflowType = 'reviewLcd'" })`. Status comes from each item's `status.name` mapped to `WorkflowRuntimeStatus`. `queryReviewStatus` wraps `handle.query(reviewStatusQuery)` in `Promise.race` with a timer; on timeout OR on a gRPC deadline error, return `'worker-unavailable'` — every other error rethrows (fail loud). Clear the timer in a `finally`.
- [ ] **Step 2:** Unit-test only the race logic by extracting it as `export async function withWorkerTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T | 'worker-unavailable'>` and testing that pure helper (resolves→value, hangs→'worker-unavailable', rejects→rethrow). Run: `node --test src/workflow/client.test.ts` → PASS; `npx tsc --noEmit` → clean.
- [ ] **Step 3:** Commit (supervisor).

### Task 5: Job store and status merge (pure logic)

**Files:**
- Create: `src/ui/jobs.ts`
- Create: `src/ui/status.ts`
- Test: `src/ui/jobs.test.ts`, `src/ui/status.test.ts`

**Interfaces:**
- Produces:

```ts
// src/ui/jobs.ts — no I/O, no imports beyond node:crypto
export type JobStatus = 'extracting' | 'starting-review' | 'attached' | 'failed';
export interface Job {
  readonly id: string; readonly lcdId: string; readonly articleId: string;
  status: JobStatus; workflowId?: string; error?: string; readonly createdAt: string;
}
export class JobStore {
  create(lcdId: string, articleId: string, now: () => string): Job; // returns the EXISTING job if one for lcdId is in 'extracting'|'starting-review' (idempotent submit)
  get(id: string): Job | undefined;
  list(): Job[];
  markStartingReview(id: string): void;   // throws on unknown id or wrong prior state
  markAttached(id: string, workflowId: string): void;
  markFailed(id: string, error: string): void;
}

// src/ui/status.ts — pure function, fully unit-testable
// NOTE: declare ReviewStatus and WorkflowRuntimeStatus as LOCAL literal-union
// aliases (same members as Tasks 3/4) — this task runs in parallel with Task 4,
// so it must not import from client.ts. Structural typing keeps them compatible;
// the Task 6 reviewer reconciles to imports if desired.
export interface WorkflowSnapshot {
  readonly workflowId: string;
  readonly status: WorkflowRuntimeStatus;
  readonly reviewStatus?: ReviewStatus | 'worker-unavailable'; // present when RUNNING
  readonly outcome?: 'approved' | 'rejected';                  // present when COMPLETED
  readonly failureReason?: string;                             // present when FAILED/TERMINATED/TIMED_OUT
}
export type Phase = JobStatus | ReviewStatus | 'worker-unavailable' | 'approved' | 'rejected' | 'workflow-failed';
export interface StatusEntry {
  readonly lcdId: string; readonly jobId?: string; readonly workflowId?: string;
  readonly phase: Exclude<Phase, 'attached'>; readonly error?: string;
}
export function mergeStatus(jobs: readonly Job[], workflows: readonly WorkflowSnapshot[]): StatusEntry[];
```

- [ ] **Step 1:** Write failing tests. JobStore: create/dedup (second `create` for same lcdId while first is `extracting` returns the first; after `markFailed` a new `create` makes a fresh job), transition guards throw on wrong state. mergeStatus mapping table (one test per row):
  - job `extracting`/`starting-review`, no workflow → phase as-is.
  - job `failed` → `failed` with error.
  - job `attached` + RUNNING workflow with `reviewStatus: 'validating'` → `validating` (joined on workflowId, one entry).
  - RUNNING + `reviewStatus: 'worker-unavailable'` → `worker-unavailable`.
  - COMPLETED + outcome → `approved` / `rejected`.
  - FAILED/TERMINATED/TIMED_OUT → `workflow-failed` with `failureReason` as error.
  - workflow with NO matching job (server restarted) → entry present, `lcdId` = `workflowId` with the `review-` prefix stripped, no jobId.
  Use namespaced fixture ids (`TEST-L1`).
- [ ] **Step 2:** Run: `node --test src/ui/jobs.test.ts src/ui/status.test.ts` → FAIL.
- [ ] **Step 3:** Implement both modules minimally.
- [ ] **Step 4:** Run the same → PASS; `npx tsc --noEmit` → clean.
- [ ] **Step 5:** Commit (supervisor).

### Task 6: HTTP server + page

**Files:**
- Create: `src/ui/server.ts`
- Create: `src/ui/index.html`
- Test: `src/ui/server.test.ts` (route handlers exercised via injected fakes — no live Temporal/Neo4j/LLM)

**Interfaces:**
- Consumes everything above: Task 1 (`extractAndSnapshot`, `extractArticleAndSnapshot`, `unionCodes`, `FIXTURES_DIR`, `projectAndWrite`), Task 2 (`readSubgraph`), Task 4 (all four helpers + `startReview`, `signalReview` already in client.ts), Task 5 (`JobStore`, `mergeStatus`).
- Produces: `node src/ui/server.ts` listening on `127.0.0.1:${UI_PORT ?? 8006}`.

Routes (method + path → behavior):

```
GET  /                                → src/ui/index.html (read once at startup)
GET  /api/runs                        → mergeStatus(jobs.list(), await snapshotWorkflows())
POST /api/runs                        → multipart {lcdPdf, articlePdf}; 400 unless both present,
                                        both filenames' derived ids match SAFE_ID; write PDFs to
                                        FIXTURES_DIR; jobs.create(); fire runChain() unawaited; 202 {jobId}
GET  /api/reviews/:workflowId         → id validation; readSubgraph via createGraph/close; 200 JSON
POST /api/reviews/:workflowId/signal  → JSON {decision:'approve'|'reject', reviewer: non-empty, note?};
                                        signalReview(); WorkflowNotFoundError → describeReview():
                                        that ALSO throws → 404 "no such review";
                                        it returns a closed status → 409 "this review was already decided";
                                        it returns RUNNING → rethrow (unexpected); else 200
POST /api/lcds/:lcdId/project         → SAFE_ID check; projectAndWrite(lcdId); 200 {artifacts, paths}
                                        (readApprovedSubgraph inside it already 409s drafts by throwing —
                                        map that specific "not approved" error message to 409)
```

Key implementation requirements (verbatim from spec — do not weaken):

```ts
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;          // derived via lcdIdFromPath on the CLIENT filename
// multipart, zero-dep (Node >= 22 undici):
const form = await new Response(req, { headers: { 'content-type': req.headers['content-type']! } }).formData();
// runChain (unawaited; every await wrapped so ANY throw -> jobs.markFailed(id, String(err))):
//   extractAndSnapshot(lcdPdfPath, ollamaClient())      // LCD FIRST, then article — cli.ts run's order
//   extractArticleAndSnapshot(articlePdfPath, ollamaClient())
//   jobs.markStartingReview(id)
//   startReview({ lcd: {...unionCodes(...) as in cli.ts runRun...}, article: {...} })
//     catch WorkflowExecutionAlreadyStartedError -> treat as success (attach)
//   jobs.markAttached(id, workflowId)
// snapshotWorkflows(): listReviewWorkflows(); for RUNNING -> reviewStatus = await queryReviewStatus(id);
//   for COMPLETED -> outcome from a Map<workflowId, ReviewResult> cache, filled via getReviewResult once;
//   for FAILED/TERMINATED/TIMED_OUT -> failureReason = the status name (POC-sufficient)
```

Testability requirement: `server.ts` exports `createHandlers(deps)` where `deps` bundles every imported side-effecting function (`extractAndSnapshot`, `startReview`, `listReviewWorkflows`, `queryReviewStatus`, `getReviewResult`, `signalReview`, `describeReview`, `projectAndWrite`, `readSubgraph`, graph factory, `llm`), and the `node src/ui/server.ts` entrypoint wires the real ones. Tests call the handlers with fakes and plain request-shaped objects.

`index.html` (single file, vanilla JS, no CDN):
- Upload form: two `<input type=file accept=application/pdf>` (LCD, article) + submit → `fetch POST /api/runs` with `FormData`.
- Runs table rendered from `GET /api/runs` — one row per StatusEntry: lcdId, phase badge, error text if any, a "Review" link when `awaiting-review`, the worker hint (`node src/workflow/worker.ts`) when `worker-unavailable`, a "Generate artifacts" button when `approved`, a "Retry" button when `failed` (re-POSTs the stored files is NOT possible — retry just tells the user to re-upload; render it as a hint, not a button, to stay honest).
- Review panel (shown for a selected workflowId): requirements grouped by `category`, covered codes, article codes, denial reasons; reviewer text input (required), note input (optional), Approve/Reject buttons that disable both on first click; render the 409 "already decided" message if returned.
- Artifacts panel: after `POST /api/lcds/:lcdId/project`, pretty-print each artifact in a `<details>` block with a download link built from a `Blob`.
- Polling: 2.5s while any entry is in `extracting|starting-review|proposing|validating`; 15s when the most active state is `awaiting-review|worker-unavailable`; stop when all entries terminal; pause/resume on `visibilitychange`.
- All rendering via `createElement`/`textContent` — no `innerHTML` with data values.

- [ ] **Step 1:** Write failing handler tests with fakes: upload happy path (202 + job created + chain ran in order + attach), unsafe filename → 400, missing part → 400, duplicate submit → same jobId, chain failure at each stage → job `failed` with verbatim message, AlreadyStarted → attached, signal 404 vs 409 vs 200 paths, project route mapping "not approved" → 409, `GET /api/runs` returns mergeStatus output including worker-unavailable and workflow-failed rows.
- [ ] **Step 2:** Run: `node --test src/ui/server.test.ts` → FAIL.
- [ ] **Step 3:** Implement `server.ts` + `index.html`.
- [ ] **Step 4:** Run: `node --test src/ui/server.test.ts` → PASS; `npx tsc --noEmit` → clean.
- [ ] **Step 5:** Commit (supervisor).

### Task 7: Wiring, docs, full verification

**Files:**
- Modify: `.env.example` (add `UI_PORT=8006` with a one-line comment)
- Modify: `README.md` (add `node src/ui/server.ts` to the walkthrough where review-signal is described, as the UI alternative)
- Modify: `CLAUDE.md` (Commands section: `node src/ui/server.ts    # review-console UI (blocks; run in its own terminal)`)
- Test: full suite

- [ ] **Step 1:** Make the three doc/env edits; README command text must match cli.ts USAGE conventions.
- [ ] **Step 2:** Run: `npx tsc --noEmit` → clean; `npm test` → full suite green (includes the live-LLM M1 gate — several minutes; requires Ollama up and NOT concurrently busy).
- [ ] **Step 3:** Manual smoke (supervisor, documented in the PR/commit message): start worker + UI server, upload the two L33822 PDFs, watch phases advance, approve as `TEST-Reviewer`, generate artifacts, confirm `out/` files regenerate byte-identical shapes; also verify the worker-down state by stopping the worker and reloading.
- [ ] **Step 4:** Commit (supervisor).

## Execution notes (supervisor)

- Wave 1 (parallel, disjoint files): Task 1, Task 2, Task 3+4 (same agent, sequential), Task 5.
- Wave 2: Task 6 (depends on all interfaces above).
- Wave 3: Task 7 + smoke test.
- Task 2 is the qwen-delegate candidate (small, pattern-mirroring); supervisor applies and tests its output.
- Agents do not commit; supervisor reviews each diff against this plan and commits per task.
