# M5 plan — end-to-end glue + README

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One implementer per task, in order; each task ends with green `npm run typecheck` + its named tests, and a plain-message commit.

**Goal:** `node cli.ts run <lcd.pdf> <article.pdf>` chains extract → article-extract → review workflow → (human approve signal) → projection, for any LCD/article pair; README lets a fresh clone reproduce the whole chain and add a second LCD with no code change.

**Spec:** PA-AI-POC-PLAN.md (M5) + CLAUDE.md. The M3/M4 facts in CLAUDE.md are binding (shared-Temporal note, verified canonicals, profile-tag absences).

## Global Constraints

- TypeScript strict, ESM, Node type stripping: `.ts` import extensions, `erasableSyntaxOnly`. `npx tsc --noEmit` clean.
- No document-specific data in `src/` or `cli.ts` — `L33822`/`A52464` may appear ONLY in README prose and fixtures. Fail loud, actionable messages naming the fix.
- Tests `node --test`; cli tests live in `test/`. Commit per task, plain messages, **no Co-Authored-By trailer**.
- Existing verbs' stdout/stderr contracts must not change — `extract`, `extract-article`, `review-start`, `review-signal`, `project` behave byte-identically (their tests prove it; do not touch those tests).
- The `run` happy path invokes the live LLM and blocks on a human signal — it is deliberately NOT covered by an automated test. `npm test` must stay deterministic apart from the existing M1 acceptance gate. The controller verifies `run` live on the real documents after review.

## Design (binding)

- `src/workflow/client.ts` — add `awaitReview(workflowId: string): Promise<ReviewResult>`: `loadTemporalConfig()`, `Connection.connect({ address })`, `new Client({ connection, namespace })`, `getHandle(workflowId).result()`, connection closed in finally. `ReviewResult` is already exported from `./review.workflow.ts` (`{ lcdId, outcome: 'approved' | 'rejected' }`); re-use via `import type`. No timeout — the indefinite block is the feature.
- `cli.ts` — new verb `run <lcd.pdf> <article.pdf>`; both args required else usage error. Flow:
  1. **Fail fast on missing inputs:** before any LLM call, check both paths exist (`access` from `node:fs/promises`); a missing file throws naming that exact path and which argument it was (`LCD PDF not found: <path>` / `Article PDF not found: <path>`).
  2. Extract LCD and article exactly as the `extract` / `extract-article` verbs do — refactor the shared cores out of `runExtract`/`runExtractArticle` into module-local helpers (e.g. `extractAndSnapshot(pdfPath)` returning `ExtractionResult`, `extractArticleAndSnapshot(pdfPath)` returning `ArticleExtractionResult`) so both verbs and `run` call one implementation; snapshots still land in `fixtures/` identically; warnings still go to stderr.
  3. Build `ReviewInput` from the in-memory results the same way `runReviewStart` builds it from snapshots (`coveredCodes` = article's `hcpcsCodes`), `startReview`, print the workflow id to stdout immediately, and print to stderr: the worker reminder (`node src/workflow/worker.ts`) and the exact signal command for this workflow id.
  4. `awaitReview(workflowId)` — blocks until the human signals.
  5. On `outcome === 'approved'`: project and write `out/<lcdId>.{crd,dtr,plandefinition}.json` exactly as the `project` verb does — refactor `runProject`'s core into a module-local `projectAndWrite(lcdId): Promise<void>` used by both. On `'rejected'`: throw `Review rejected — <lcdId> was not projected.` (existing top-level catch → stderr + exit 1).
- `run` performs no `load` — the workflow's propose activity loads the graph; that is the M3 contract.

## Task 1 — run verb + awaitReview

Files: modify `src/workflow/client.ts`, `cli.ts`; create `test/cli-run.test.ts`.

TDD on the deterministic surface; tests first (mirror `test/cli-project.test.ts` mechanics: temp cwd via `mkdtemp`, spawn `node <repo>/cli.ts` with array args, env passthrough; no graph/Temporal access needed — none of these tests reaches a backend):
- `run` with no args → exit 1, stderr matches /Usage/.
- `run` with one arg → exit 1, stderr matches /Usage/.
- `run` with a nonexistent LCD path → exit 1, stderr names that exact path (write no files first; both args point into the temp cwd).
- `run` where the LCD path exists (write a dummy file, content irrelevant — the existence check precedes any parse) but the article path doesn't → exit 1, stderr names the article path (proves check order and that no LLM/parse ran: assert the error is the missing-file one, and that stderr does NOT contain a parse/extract failure).
- USAGE text includes the new verb line (assert /run <lcd\.pdf>/ appears in the usage output of the no-args failure).

Steps: failing tests (`node --test test/cli-run.test.ts` — verb doesn't exist yet, expect the Unknown-command usage error to make some tests pass trivially; the missing-file tests are the real RED) → implement client + cli refactor → all 5 green → regression: `node --test test/cli-project.test.ts test/cli-load.test.ts test/cli-extract.test.ts test/cli-article.test.ts test/cli-review.test.ts` (proves the refactor didn't change existing verbs; these need the dockerized Neo4j and shared Temporal from `.env`, both running) → `npx tsc --noEmit` → commit `M5 task 1: run verb chains extract through review to projection`.

## Task 2 — README

Files: create `README.md` only.

Audience: a Da Vinci Project member cloning fresh. Every command must be copy-paste correct against the actual cli (read `cli.ts` USAGE and `.env.example` before writing; do not invent flags). Required sections, in order:
1. **What this is** — one paragraph + the four-stage pipeline diagram (PDF → LLM extraction → Neo4j graph → Temporal human-gated review → FHIR projection); L33822 (Glucose Monitors) is the demonstration fixture, not a hardcoded subject.
2. **What's proven vs. deliberately deferred** — proven: PDF→graph→governed-review→FHIR shape on a real LCD/article pair, structural R4 validity, correct Da Vinci `meta.profile` tags (and the two verified profile-tag absences: CDS Hooks card is not a FHIR resource; no CRD/DTR PlanDefinition profile exists). Deferred on purpose: full IG conformance (M6 stretch), executable CQL (stub Library canonical), live CDS Hooks service. State that scoping these out is deliberate.
3. **Prerequisites** — Node ≥ 22.18, Docker, Temporal CLI, Ollama with the model from `EXTRACTION_MODEL` (default `qwen3.8:27b`), and the two MCD PDFs: explain they are "Create PDF" exports from the Medicare Coverage Database that cannot be fetched programmatically and are not redistributed; the pipeline fails loud with placement instructions if absent.
4. **Setup** — `npm install`, `cp .env.example .env`, `docker compose up -d`, `temporal server start-dev` (note: if a Temporal already occupies :7233, create a dedicated namespace instead and set `TEMPORAL_NAMESPACE` — mirror `.env.example`'s comment).
5. **Run the full chain** — three terminals: (A) `node src/workflow/worker.ts`; (B) `node cli.ts run fixtures/L33822.pdf fixtures/A52464.pdf` — prints the workflow id, then blocks; (C) `node cli.ts review-signal review-L33822 approve <your-name>`. Then B unblocks and writes `out/L33822.{crd,dtr,plandefinition}.json`. Call out explicitly that the indefinite block in B is the durable human gate — the point of the design, not a hang. Also list the step-by-step verbs (`extract`, `extract-article`, `load`, `review-start`, `review-signal`, `project`) as the granular alternative.
6. **Add a second LCD** — place `fixtures/<lcdId>.pdf`, the paired article PDF, and a hand-authored `fixtures/<lcdId>.expected.json`; run the same commands with the new paths; no source file changes. This section proves the generic claim.
7. **Testing** — `npm test` (mention the ~40s live-model M1 gate and that graph/Temporal-backed tests need the containers up), `npm run typecheck`.
8. **Graph model** — copy the model sketch from CLAUDE.md's "Graph model" section (the CLAUDE.md version, which supersedes the plan's).
9. **License** — MIT (matches package.json).

No tests. Verify: every command in the README must be greppable in `cli.ts`/`package.json`/`docker-compose.yml` (spot-check each before writing it), `npx tsc --noEmit` still clean (no code touched). Commit `M5 task 2: README with full-chain walkthrough and second-LCD guide`.

## Acceptance (controller runs, real stack — not the implementer)

Worker in a background terminal, then `node cli.ts run fixtures/L33822.pdf fixtures/A52464.pdf`, approve via `review-signal` from a second shell, confirm the command unblocks, exits 0, and `out/L33822.*.json` regenerate with the M4-verified shapes (14 items / 20 actions). Reject path spot-checked the same way only if time permits — the workflow tests already cover it.
