# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Read `PA-AI-POC-PLAN.md` in full before writing code — it is the authority on scope, milestone ordering, and the acceptance bar.

**Current milestone: M1 built and green; M2 is next.** Keep this line current as milestones land; it is the fastest way for a fresh session to know where the build stands.

**M1's acceptance gate has not run against a real LCD.** `test/acceptance.test.ts` discovers `fixtures/*.expected.json` and skips when there are none — so `npm test` is green without proving anything about a real coverage policy. The chain was proven end-to-end against the live model on a synthetic two-page PDF only. Placing `fixtures/L33822.pdf` plus a hand-authored `fixtures/L33822.expected.json` is what closes M1.

## What this project is

A POC pipeline that turns a Medicare LCD coverage-policy PDF into Da Vinci CRD/DTR FHIR artifacts, through four stages:

```
PDF → LLM extraction (Requirement[]) → Neo4j graph → Temporal human-gated review → FHIR projection
```

L33822 (Glucose Monitors) is the acceptance target, but it is a *fixture*, not a subject. This is intended as a public reference repo shown to Da Vinci Project members.

## Architectural constraints that govern every change

These are the non-obvious rules; violating them defeats the point of the POC.

- **No document-specific data in `src/`.** No source file may contain `L33822`, its HCPCS codes, requirement wording, or denial codes. Everything document-specific enters through `fixtures/` keyed by LCD id. A reviewer must be able to add a second LCD by dropping in three files (`<id>.pdf`, paired article PDF, `<id>.expected.json`) without opening `src/`.
- **Extraction is the only non-deterministic stage, and it is quarantined.** M1 writes `fixtures/<lcdId>.extracted.json`; M2–M4 tests read that snapshot and must never invoke the LLM. Graph and FHIR stages are pure functions of their inputs.
- **Local LLM only.** Ollama at `http://localhost:11434`, model from `EXTRACTION_MODEL` (default `qwen3.8:27b`). No cloud fallback. The call stays behind `src/extract/llm-client.ts` as an interface — that is design hygiene, not a hook for swapping in a bigger model.
- **`status` gates projection.** Only an `approved` LCD may be projected to FHIR; projecting a `draft` must throw.
- **Fail loud, never stub silently.** Missing fixtures, malformed LLM output, or a draft projection throw with actionable messages. Never fabricate placeholder data to make a stage appear to pass. Malformed LLM JSON: retry once with a sharper instruction, then throw *with the raw model output in the error*.
- **Do not loosen the M1 assertion to make it pass.** If the local model can't reliably hit the expected requirement count / category distribution / key phrases, that is a finding to surface, not a test to soften. M1 asserts structure and key-phrase presence — never exact prose.
- TypeScript strict, ESM, Node ≥ 22. No `any` in domain types. Every LLM/PDF/graph boundary is a typed adapter. Child processes use array args with `shell: false`. Credentials and endpoints come from env (`.env.example` committed, `.env` gitignored).

## Graph model

Nodes `LCD`, `Code`, `Requirement`, `ICD10`, `DenialReason`; relationships `COVERS`, `REQUIRES`, `DIAGNOSIS_OF`, `FAILS_AS`. `LCD.sourceHash` is a sha256 of the extracted source text so re-runs detect a changed PDF. Uniqueness constraints on `LCD.id`, `Code.code`, `Requirement.id`. Full property lists are in the plan's "Domain model" section.

The ICD-10 codes and denial reasons come from a *paired policy article* PDF (A52464 for L33822), not the LCD itself.

## Module map

Nothing under `src/` exists yet; this is the layout the plan commits to, and where new code belongs.

- `src/extract/` — `pdf-text.ts` (PDF → text + section map), `sections.ts` (heading-based splitter, warns rather than crashes on a missing section), `structure.ts` (LLM → `Requirement[]`), `llm-client.ts` (the only Ollama-aware file)
- `src/graph/` — `schema.ts` (node/rel constants + constraints), `write.ts` (upsert), `read.ts` (approved subgraph for projection), `validate.ts` (cycle / duplicate / orphan report)
- `src/workflow/` — `activities.ts` (propose, validate, commit, compensate), `review.workflow.ts`, `worker.ts`, `client.ts` (start + signal)
- `src/fhir/` — `crd.ts`, `dtr.ts`, `plandefinition.ts`, `profiles.ts` (every Da Vinci canonical URL lives here, nowhere else)
- `src/types.ts` shared domain types; `src/cli.ts` the single orchestration entrypoint for every verb below

## Milestones

Build strictly in order M1→M5; do not start a milestone until the previous one's tests pass, and commit per milestone with a message naming it. M6 (full Da Vinci IG conformance against real StructureDefinitions) is a labeled stretch goal, explicitly outside the done bar — M4 only does base-R4 structural validation plus correct `meta.profile` canonical URLs (kept in one `src/fhir/profiles.ts`).

## Commands

```bash
npm test                                    # node --test; TS runs unbuilt via Node type stripping
node --test src/extract/sections.test.ts    # one file
node --test --test-name-pattern 'combined'  # one test by name
npx tsc --noEmit                            # typecheck (npm run typecheck)

node cli.ts extract <lcd.pdf>               # M1, implemented: prints Requirement[], snapshots to fixtures/
```

Not yet implemented — the interface the plan commits to:

```bash
docker compose up -d                        # neo4j (see "Neo4j" below)
temporal server start-dev                   # temporal dev server
node cli.ts load                            # M2: upsert subgraph + run validate report
node cli.ts run <lcd.pdf> <article.pdf>     # M5: full chain; prints workflow id, then blocks on signal
node cli.ts project <lcdId>                 # M4: emits out/<lcdId>.{crd,dtr,plandefinition}.json
```

## Decisions taken in M1

- **`cli.ts` is at the repo root**, not `src/cli.ts` as the plan's layout diagram shows, so the documented `node cli.ts extract` works verbatim. It is thin glue over `src/extract/extract.ts`.
- **`lcdId` comes from the PDF filename** (`fixtures/L33822.pdf` → `L33822`). Fixtures are keyed by LCD id, so the filename already carries it; nothing parses ids out of document text.
- **The model does not assign `id` or `ordinal`.** It returns only `{text, category}`; `structure.ts` numbers requirements deterministically as `<lcdId>-R<n>`. Model-assigned ids would collide and drift between runs, and M2 puts a uniqueness constraint on them.
- **A combined heading is extracted once.** "Coverage Indications, Limitations, and/or Medical Necessity" puts one body under two sections; `structure.ts` groups sections sharing a body into a single LLM call whose allowed categories are the union, so the same text never yields duplicate requirements.
- **Ollama is called with a JSON Schema** (`format`) and `think: false`, temperature 0, via `/api/generate`. Verified against the live endpoint.
- **Node ≥ 22.18** (`engines`), where type stripping is on by default — that is what lets `node cli.ts` run TypeScript unbuilt.

## Neo4j

`docker compose up -d` starts `pa-fhir-poc-neo4j`, a Community container dedicated to this POC. Community serves exactly one user database per instance, so the POC gets its own container rather than an extra database inside a shared one; `NEO4J_DATABASE` (default `pafhirpoc`) becomes that instance's default database via `initial.dbms.default_database`.

Credentials and ports come from `.env` (copy `.env.example`); compose fails loudly if `NEO4J_USER`/`NEO4J_PASSWORD` are unset. Host ports are overridable (`NEO4J_HTTP_PORT`, `NEO4J_BOLT_PORT`) because two other stopped Neo4j containers on this machine claim 7474/7687 and 7475/7689.

The healthcheck runs `cypher-shell 'RETURN 1'`, so `healthy` means the database answers queries, not just that a port is open. It reads `HEALTHCHECK_USER`/`HEALTHCHECK_PASSWORD` — deliberately not `NEO4J_`-prefixed, since the image's entrypoint treats those as server settings.

The Temporal review workflow (`propose → validate → await signal → commit | compensate`) blocks indefinitely on a human `{ decision, reviewer, note }` signal — that block is the feature, not a bug. `src/workflow/client.ts` sends it; M3 tests use `@temporalio/testing`.

## Fixtures the human supplies

`fixtures/L33822.pdf` and `fixtures/A52464.pdf` are "Create PDF" exports from the Medicare Coverage Database. **Do not attempt to fetch them** — the MCD is a dynamic search UI, not a flat store. If absent, fail with a message telling the human to place them.

## Open questions (leave as TODO comments; do not resolve silently)

- Requirement 5 (6-month visit) as its own node vs. a temporal property on Requirement 2 — currently a separate node.
- `DenialReason` in-graph vs. an external validation set — in-graph for the POC.
- CQL is stubbed as a `library` reference; real CQL generation is out of scope.
