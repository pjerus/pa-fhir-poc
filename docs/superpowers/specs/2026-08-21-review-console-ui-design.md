# Review Console UI — Design

## Problem

Every stage of this pipeline is a one-shot CLI command except the review
step, which blocks a Temporal workflow indefinitely on a human signal sent
from a second terminal (`node cli.ts review-signal <wfId> <approve|reject>
<reviewer> [note]`). A reviewer has to know the workflow id and hand-type a
signal command with no view of what they're approving. This spec adds a
small web UI that drives the full pipeline from PDF upload through a
domain-aware approve/reject screen to downloadable FHIR artifacts.

Out of scope, deliberately: replacing Temporal Web (already reachable at
the shared server's `temporal.test`, namespace `pa-fhir-poc`, for generic
"what workflows exist" visibility) or Neo4j Browser (for ad-hoc graph
inspection). This UI's value is the two things neither of those tools can
do: kick off the pipeline from an upload, and render the *domain* content
of a pending review (requirements, codes, denial reasons) so a human can
actually judge it.

## Architecture

One new file tree, `src/ui/`, containing a plain Node HTTP server (no
bundler, no frontend framework) that serves one static HTML page (vanilla
JS, polling) plus a small JSON API. It imports the existing pipeline
modules directly — `extractLcd`/`extractArticle` (`src/extract/`),
`startReview`/`signalReview` (`src/workflow/client.ts`), `projectLcd`
(`src/fhir/project.ts`) — so `cli.ts` and the UI server become two peer
consumers of the same `src/` library layer. No new document-specific logic:
an uploaded PDF pair is written to `fixtures/<lcdId>.pdf` and
`fixtures/<articleId>.pdf` before extraction runs, so uploading via the UI
is exactly equivalent to "drop the PDF in `fixtures/` and run the CLI."

Two pieces of state, each scoped to the phase that has no other owner:

- **`src/ui/jobs.ts`** — an in-memory `Map<jobId, JobState>` covering
  *only* the pre-workflow phase: `extracting → starting-review →
  attached (workflowId known) | failed`. This state has no other home — no
  Temporal workflow exists yet at this point. Lost on server restart,
  which is acceptable for a POC control plane and should be documented as
  a known limitation, not silently masked.
- **A `reviewStatus` query added to `review.workflow.ts`** — Temporal's
  `describe()` only reports coarse `WorkflowExecutionStatus`
  (RUNNING/COMPLETED/FAILED/...), which cannot distinguish "still running
  the `propose`/`validate` activities" from "genuinely blocked on the
  human signal." A `defineQuery<'proposing' | 'validating' |
  'awaiting-review'>('reviewStatus')` handler, set alongside the existing
  `reviewSignal` handler, exposes that distinction natively. This is a
  small, additive, non-determinism-affecting change (queries never touch
  workflow history) — not a new tracking table, just the correct native
  mechanism for exposing workflow-internal state to an external reader.

Once a job records a `workflowId`, **the job map is never asked "is this
still open" again — only Temporal is.** The map's only lifetime purpose is
remembering which workflow a given upload produced.

## Components

- `POST /api/runs` (multipart: `lcdPdf`, `articlePdf`) → derives `lcdId`
  from the LCD PDF's filename (existing convention), writes both files
  into `fixtures/`, and returns `{jobId}` immediately. The
  extract-article → extract-lcd → `startReview()` chain (mirroring
  `cli.ts run`'s happy path, minus the blocking `awaitReview()`) runs
  unawaited.
  - **Idempotent submit:** if a non-terminal job already exists for that
    `lcdId`, return its existing `jobId` instead of starting a duplicate.
  - **Idempotent `startReview()`:** `startReview()` already uses a
    deterministic workflow id (`review-${lcdId}`); Temporal's default
    `WorkflowIdReusePolicy` rejects a second `start()` on an open id with
    `WorkflowExecutionAlreadyStartedError`. Treat that error as "attach
    this job to the already-running workflow," not a failure — this is
    Temporal's own idempotency primitive, not something to reimplement.
- `GET /api/runs` / `GET /api/runs/:jobId` → merges the job map
  (pre-workflow) with `describe()` + the `reviewStatus` query
  (post-workflow) into one status feed for polling.
- `GET /api/reviews/:workflowId` → the pending LCD's requirements, covered
  codes, article info, and denial reasons, for the review screen. Requires
  a subgraph reader that works on a `draft` LCD — see Open Question below.
- `POST /api/reviews/:workflowId/signal` `{decision, reviewer, note}` →
  calls the existing `signalReview()`, unchanged.
- `GET /api/lcds/:lcdId/artifacts` → once the workflow result is
  `approved`, calls `projectLcd()` and returns the three artifact JSON
  blobs for view/download.

## Data flow

1. Upload → `lcdId` derived from filename → PDFs written to `fixtures/`.
2. `POST /api/runs` creates `{id, lcdId, status: 'extracting'}` (or returns
   an existing non-terminal job for that `lcdId`) and responds
   immediately; the chain below runs unawaited.
3. `extractArticle()` then `extractLcd()` run (mirroring
   `extractArticleAndSnapshot`/`extractAndSnapshot` in `cli.ts`). Any
   thrown error → job `status: 'failed'`, the raw thrown message attached
   verbatim.
4. On success, job moves to `status: 'starting-review'`; build the
   `LcdInput`/`ArticleInput` (per `cli.ts run`'s shape) and call
   `startReview({lcd, article})`.
   - Success, or `WorkflowExecutionAlreadyStartedError` → job records
     `workflowId`, `status: 'attached'`. From here the job map is
     read-only history; all live status comes from Temporal.
   - Any other error → job `status: 'failed'`.
5. Frontend polls `GET /api/runs`; once a job has a `workflowId`, poll
   `GET /api/runs/:jobId`, which internally calls `describe()` +
   `reviewStatus` query. Render `proposing`/`validating` as an in-progress
   state, `awaiting-review` as an actionable "Review" link.
6. `GET /api/reviews/:workflowId` reads the pending subgraph and renders
   requirements (grouped by category), covered codes, article-listed
   codes, and denial reasons.
7. Reviewer enters an optional note, clicks Approve or Reject. Client
   disables both buttons immediately on click (prevents a double-click
   from firing two signal requests — the natural guard, since the
   workflow's signal handling is otherwise already safe against a
   duplicate signal landing after `condition()` resolves).
8. `POST /api/reviews/:workflowId/signal` calls `signalReview()`. A
   signal against a nonexistent or already-completed workflow throws from
   the Temporal client — mapped to a 404/409 with a clear message, not a
   generic 500.
9. After a successful signal, the poll endpoint's `describe()` call
   eventually reports `COMPLETED`; the server then calls `.result()` to
   get `{lcdId, outcome}`. `approved` → show a "Generate artifacts"
   action calling `GET /api/lcds/:lcdId/artifacts` (which runs
   `projectLcd()` against `readApprovedSubgraph()` — valid now that
   `commit` has flipped status to `approved`). `rejected` → show the
   reviewer/note, no further action.

## Open question (not a blocker, flag before implementation)

`readApprovedSubgraph()` throws if the LCD's status isn't `approved` — by
design, since M4 never projects a draft. The review screen (step 6 above)
needs to read a **pending** (`draft`) LCD's subgraph. Either add a
status-agnostic sibling function in `src/graph/read.ts` (e.g.
`readSubgraph(graph, lcdId)` without the approval guard, with
`readApprovedSubgraph` becoming a thin wrapper that adds the guard back),
or parameterize the existing function. Small either way; decide during
implementation, not here.

## Error handling

- Multipart upload validation (missing file, wrong type) → 400 before any
  LLM cost is spent.
- Any pre-workflow chain-step failure → job `failed`, verbatim error
  message, a manual "retry" action in the UI. **No automatic retry or
  backoff for extraction failures** — `structure.ts` already retries once
  with a sharper instruction and throws with the raw model output on a
  second failure; stacking a second retry layer on a non-deterministic
  call risks masking a real extraction-quality problem, which is exactly
  what this project's fail-loud convention exists to prevent. A human is
  already watching the browser tab; a manual retry button is enough.
- Neo4j/Temporal connectivity failures inside the chain or in a route
  handler → fail fast, surface the thrown error as-is. No added
  backoff — consistent with this project's existing convention of never
  papering over infrastructure failures with silent retries.
- Signal against a nonexistent/already-completed workflow → 404/409 with
  a specific message ("this review was already decided" /
  "no such pending review"), not a generic 500.
- Artifact generation errors surface directly — `projectLcd()` already
  throws loudly per existing convention.

## Polling backoff (client-side)

- Fast polling (~2-3s) while a job is `extracting`/`starting-review` or a
  workflow reports `proposing`/`validating`.
- Slow polling (~15s) once `awaiting-review` — a human, not a machine, is
  now the bottleneck.
- Stop polling entirely once terminal: `failed`, `approved`, `rejected`.
- Pause polling via the Page Visibility API when the tab isn't focused.

## Testing

- `src/ui/jobs.ts`'s state machine (dedup-on-duplicate-submit, transition
  logic, merge-with-Temporal-status logic) gets unit tests with
  `extractLcd`/`extractArticle`/`startReview` stubbed — the same
  quarantine pattern `review.workflow.test.ts` already uses with
  `@temporalio/testing`.
- Route-level tests cover request validation and error-status mapping
  (bad upload, already-started workflow, already-completed workflow)
  deterministically — no live LLM/Temporal/Neo4j.
- No new Docker/Java/network additions to `npm test`, matching the
  existing M6 precedent for `validate`.
- A live end-to-end run (real PDFs, full state walk to a downloaded
  artifact) stays a documented manual smoke test — the same tier as
  `cli.ts run`'s happy path today.
- The single HTML/vanilla-JS page gets a manual-testing note in the
  implementation plan; no new frontend test tooling for a POC page.
