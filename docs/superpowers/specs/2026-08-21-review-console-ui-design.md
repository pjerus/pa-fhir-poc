# Review Console UI — Design

## Problem

Every stage of this pipeline is a one-shot CLI command except the review
step, which blocks a Temporal workflow indefinitely on a human signal sent
from a second terminal (`node cli.ts review-signal <wfId> <approve|reject>
<reviewer> [note]`). A reviewer has to know the workflow id and hand-type a
signal command with no view of what they're approving. This spec adds a
small web UI that drives the full pipeline from PDF upload through a
domain-aware approve/reject screen to downloadable FHIR artifacts.

Out of scope, deliberately: replacing Temporal Web (already reachable for
generic "what workflows exist" visibility) or Neo4j Browser (for ad-hoc
graph inspection). This UI's value is the two things neither of those
tools can do: kick off the pipeline from an upload, and render the
*domain* content of a pending review (requirements, codes, denial reasons)
so a human can actually judge it.

## Architecture

One new file tree, `src/ui/`, containing a plain Node HTTP server (no
bundler, no frontend framework) that serves one static HTML page (vanilla
JS, polling) plus a small JSON API. It imports the existing pipeline
modules directly — `extractLcd`/`extractArticle` (`src/extract/`),
`startReview`/`signalReview` (`src/workflow/client.ts`), `projectLcd`
(`src/fhir/project.ts`) — so `cli.ts` and the UI server become two peer
consumers of the same `src/` library layer.

**Pipeline equivalence is a requirement, not a slogan:** a UI-driven run
must leave the same on-disk trail as the CLI — extraction snapshots in
`fixtures/` (`<lcdId>.extracted.json`, `<articleId>.article.json`) and
projected artifacts in `out/`. `cli.ts` currently owns the
snapshot-writing helpers (`extractAndSnapshot`,
`extractArticleAndSnapshot`) and `projectAndWrite`; hoist them into `src/`
(e.g. `src/extract/snapshot.ts`, `src/fhir/write.ts`) so both consumers
share them — `cli.ts` stays thin glue, per its charter. Without this, a
UI-driven run breaks the fixture conventions M2–M4 and `cli.ts validate`
depend on.

The server binds to localhost only and runs directly, like the worker:
`node src/ui/server.ts` (same precedent as `node src/workflow/worker.ts`).
Port from `UI_PORT` in `.env` (committed default in `.env.example`).
README and CLAUDE.md's command tables gain the new command in lockstep,
per existing convention.

Two pieces of state, each scoped to the phase that has no other owner:

- **`src/ui/jobs.ts`** — an in-memory `Map<jobId, JobState>` covering
  *only* the pre-workflow phase: `extracting → starting-review →
  attached (workflowId known) | failed`. This state has no other home — no
  Temporal workflow exists yet at this point. Lost on server restart:
  acceptable, because discovery of anything past `attached` does not
  depend on it (see the visibility-listing below).
- **A `reviewStatus` query added to `review.workflow.ts`** — Temporal's
  `describe()` only reports coarse `WorkflowExecutionStatus`
  (RUNNING/COMPLETED/FAILED/...), which cannot distinguish "still running
  the `propose`/`validate` activities" from "genuinely blocked on the
  human signal." A `defineQuery<'proposing' | 'validating' |
  'awaiting-review'>('reviewStatus')` handler, set alongside the existing
  `reviewSignal` handler, exposes that distinction natively. Queries
  append nothing to workflow history and emit no commands, so adding one
  cannot affect determinism or replay of existing executions (they *can
  trigger* a replay as a read mechanism — that is normal and harmless
  here). Not a new tracking table — the correct native mechanism for
  exposing workflow-internal state to an external reader.

Once a job records a `workflowId`, **the job map is never asked "is this
still open" again — only Temporal is.** And discovery does not depend on
the job map either: `GET /api/runs` merges the in-memory jobs
(pre-workflow phase) with a Temporal **visibility listing** of open
`review-*` workflows in the namespace, so a pending review survives a UI
server restart. The job map's only lifetime purpose is showing
pre-workflow progress and remembering which upload produced which
workflow.

## Components

- `POST /api/runs` (multipart: `lcdPdf`, `articlePdf`) → derives `lcdId` /
  `articleId` from each PDF's filename (the existing `lcdIdFromPath`
  basename convention), writes both files into `fixtures/`, and returns
  `{jobId}` immediately. The extract-LCD → extract-article →
  `startReview()` chain (mirroring `cli.ts run`'s order, minus the
  blocking `awaitReview()`) runs unawaited, writing the same
  `fixtures/*.json` snapshots the CLI writes.
  - **Filename hygiene (required):** the derived ids become file paths
    (`fixtures/<id>.pdf`) and graph keys. Reject any upload whose derived
    id fails a strict safe-basename pattern (e.g. `/^[A-Za-z0-9._-]+$/`,
    no path separators) with a 400 — never write a path built from an
    unvalidated client-supplied filename.
  - **Multipart parsing, zero-dep:** Node ≥ 22's undici can parse the
    body natively — `await new Response(req, { headers:
    {'content-type': …} }).formData()`. Buffers uploads in memory, fine
    at LCD-PDF sizes; no new dependency.
  - **Idempotent submit:** if a non-terminal job already exists for that
    `lcdId`, return its existing `jobId` instead of starting a duplicate.
  - **Idempotent `startReview()`:** `startReview()` already uses a
    deterministic workflow id (`review-${lcdId}`); Temporal's workflow id
    **conflict** policy (the policy governing a *running* workflow —
    distinct from the reuse policy, which governs closed ones) defaults
    to failing a second `start()` with
    `WorkflowExecutionAlreadyStartedError`. Treat that error as "attach
    this job to the already-running workflow," not a failure — this is
    Temporal's own idempotency primitive, not something to reimplement.
- `GET /api/runs` / `GET /api/runs/:jobId` → merges the job map
  (pre-workflow) with the visibility listing and, per workflow,
  `describe()` + the `reviewStatus` query into one status feed for
  polling. See "Worker-down handling" below for the query's failure mode.
- `GET /api/reviews/:workflowId` → the pending LCD's requirements, covered
  codes, article info, and denial reasons, for the review screen. Requires
  a subgraph reader that works on a `draft` LCD — see Open Question below.
- `POST /api/reviews/:workflowId/signal` `{decision, reviewer, note}` →
  calls the existing `signalReview()`, unchanged.
- `POST /api/lcds/:lcdId/project` → once the workflow result is
  `approved`, projects and **writes `out/<lcdId>.{crd,dtr,plandefinition}
  .json` exactly as `cli.ts project` does** (so `cli.ts validate` works
  on a UI-driven run), then returns the three artifact JSON blobs for
  view/download. POST, not GET — it has side effects.

## Worker-down handling

The review worker runs manually in its own terminal; "worker not running"
is a routine state here, not an edge case. Temporal semantics split
cleanly:

- `start()` and `signal()` are written to history server-side — they
  succeed with zero workers (the workflow just doesn't progress).
- `describe()` is a pure server read — works with zero workers.
- **Queries require a live worker.** With none, the client call hangs
  until a `DEADLINE_EXCEEDED`-style timeout.

So the poll endpoint wraps the `reviewStatus` query in a short client-side
timeout; on timeout, with `describe()` still reporting RUNNING, it reports
the workflow as `worker-unavailable` — rendered distinctly in the UI
("start the worker: `node src/workflow/worker.ts`"), not lumped in with
generic errors. `describe()` results are always usable regardless.

## Data flow

1. Upload → ids derived from filenames and validated (see filename
   hygiene) → PDFs written to `fixtures/`.
2. `POST /api/runs` creates `{id, lcdId, status: 'extracting'}` (or returns
   an existing non-terminal job for that `lcdId`) and responds
   immediately; the chain below runs unawaited.
3. `extractLcd()` then `extractArticle()` run (same order as `cli.ts
   run`), each writing its `fixtures/` snapshot via the hoisted helpers.
   Any thrown error → job `status: 'failed'`, the raw thrown message
   attached verbatim.
4. On success, job moves to `status: 'starting-review'`; build the
   `LcdInput`/`ArticleInput` (per `cli.ts run`'s shape, including the
   HCPCS union) and call `startReview({lcd, article})`.
   - Success, or `WorkflowExecutionAlreadyStartedError` → job records
     `workflowId`, `status: 'attached'`. From here the job map is
     read-only history; all live status comes from Temporal.
   - Any other error → job `status: 'failed'`.
5. Frontend polls `GET /api/runs`. Per workflow, the server maps state:
   `describe()` RUNNING + query answer → `proposing`/`validating`
   (in-progress) or `awaiting-review` (actionable "Review" link);
   RUNNING + query timeout → `worker-unavailable`; **FAILED /
   TERMINATED / TIMED_OUT → surfaced as a failed review with the
   failure reason** — the workflow legitimately ends FAILED if `commit`
   or `compensate` hits an infra error (fail-loud, no try/catch in the
   workflow), and that must reach the UI, not vanish.
6. `GET /api/reviews/:workflowId` reads the pending subgraph and renders
   requirements (grouped by category), covered codes, article-listed
   codes, and denial reasons.
7. Reviewer enters an optional note, clicks Approve or Reject. Client
   disables both buttons immediately on click.
   - **Known limitation, accepted for a single-reviewer POC:** if two
     *different* decisions are delivered before the first workflow task
     processes them (second tab, network-layer retry), both handlers run
     in that one task and the later signal in history order wins — the
     earlier sender still received a 200. Button-disable narrows this to
     near-zero for one reviewer in one tab; true multi-reviewer
     arbitration would need a decision-id/first-writer-wins check inside
     the workflow, which is out of scope and recorded here rather than
     silently ignored.
8. `POST /api/reviews/:workflowId/signal` calls `signalReview()`. The TS
   SDK throws the **same** `WorkflowNotFoundError` for both a nonexistent
   id and an already-closed workflow, so the handler differentiates:
   catch it, then `describe()` — describe fails too → 404 ("no such
   review"); describe shows a closed status → 409 ("this review was
   already decided"). Not a generic 500 either way.
9. Once `describe()` reports COMPLETED, the server calls `.result()` to
   get `{lcdId, outcome}`. `approved` → show a "Generate artifacts"
   action calling `POST /api/lcds/:lcdId/project` (valid now that
   `commit` has flipped status to `approved`). `rejected` → show the
   reviewer/note, no further action. FAILED and friends were already
   surfaced in step 5.

## Open question (not a blocker, flag before implementation)

`readApprovedSubgraph()` throws if the LCD's status isn't `approved` — by
design, since M4 never projects a draft. The review screen (step 6 above)
needs to read a **pending** (`draft`) LCD's subgraph. Either add a
status-agnostic sibling function in `src/graph/read.ts` (e.g.
`readSubgraph(graph, lcdId)` without the approval guard, with
`readApprovedSubgraph` becoming a thin wrapper that adds the guard back),
or parameterize the existing function. Small either way; decide during
implementation, not here. The projection path keeps using
`readApprovedSubgraph` unchanged — the status gate on projection is not
weakened.

## Error handling

- Multipart upload validation (missing file, wrong type, unsafe derived
  id) → 400 before any LLM cost is spent.
- Any pre-workflow chain-step failure → job `failed`, verbatim error
  message, a manual "retry" action in the UI. **No automatic retry or
  backoff for extraction failures** — `structure.ts` already retries once
  with a sharper instruction and throws with the raw model output on a
  second failure; stacking a second retry layer on a non-deterministic
  call risks masking a real extraction-quality problem, which is exactly
  what this project's fail-loud convention exists to prevent. A human is
  already watching the browser tab; a manual retry button is enough.
- Neo4j/Temporal connectivity failures inside the chain or in a route
  handler → fail fast, surface the thrown error as-is. No added backoff —
  consistent with this project's existing convention of never papering
  over infrastructure failures with silent retries. The one distinction
  drawn: `worker-unavailable` (query timeout while describe() says
  RUNNING) gets its own state and remediation hint, because it's routine
  operation, not an infra failure.
- Signal errors: the catch-then-describe differentiation above (404 vs
  409), with specific messages.
- Artifact generation errors surface directly — `projectLcd()` already
  throws loudly per existing convention.

## Polling backoff (client-side)

- Fast polling (~2-3s) while a job is `extracting`/`starting-review` or a
  workflow reports `proposing`/`validating`.
- Slow polling (~15s) once `awaiting-review` or `worker-unavailable` — a
  human, not a machine, is now the bottleneck.
- Stop polling entirely once terminal: `failed`, `approved`, `rejected`,
  workflow-FAILED.
- Pause polling via the Page Visibility API when the tab isn't focused.

## Testing

- `src/ui/jobs.ts`'s state machine (dedup-on-duplicate-submit, transition
  logic) gets plain unit tests with `extractLcd`/`extractArticle`/
  `startReview` stubbed — no live LLM ever, per the extraction
  quarantine.
- The status-merge logic (job map × visibility listing × describe ×
  query result → one feed entry) is a pure function; unit-test it
  directly, including the `worker-unavailable` and workflow-FAILED
  mappings.
- Route-level tests cover request validation (including unsafe-filename
  rejection) and error-status mapping (bad upload, already-started
  workflow, `WorkflowNotFoundError` → 404-vs-409 differentiation)
  deterministically — no live LLM/Temporal/Neo4j.
- The `reviewStatus` query handler gets a test in the existing
  `review.workflow.test.ts` `@temporalio/testing` harness (query returns
  `awaiting-review` once `propose`/`validate` complete).
- No new Docker/Java/network additions to `npm test`, matching the
  existing M6 precedent for `validate`.
- A live end-to-end run (real PDFs, full state walk to a downloaded
  artifact, including a worker-down check) stays a documented manual
  smoke test — the same tier as `cli.ts run`'s happy path today.
- The single HTML/vanilla-JS page gets a manual-testing note in the
  implementation plan; no new frontend test tooling for a POC page.
