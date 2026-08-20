# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repo currently contains **only** `PA-AI-POC-PLAN.md` — no source, no `package.json`, no git repo. The plan is the spec; everything below is derived from it. Read `PA-AI-POC-PLAN.md` in full before writing code — it is the authority on scope, milestone ordering, and the acceptance bar.

**Current milestone: none started — M1 is next.** Keep this line current as milestones land; it is the fastest way for a fresh session to know where the build stands.

`git init` before starting M1 — the plan mandates a commit per milestone and there is no repository yet.

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

## Planned commands

Not yet implemented — these are the interface the plan commits to.

```bash
docker compose up -d              # neo4j
temporal server start-dev         # temporal dev server
npm test                          # node --test, colocated *.test.ts
node --test test/extract.test.ts  # one file (Node >= 23.6 strips TS natively; on Node 22.6-22.17 add --experimental-strip-types)
node --test --test-name-pattern 'rejects a draft'   # one test by name

node cli.ts extract <lcd.pdf>              # M1: prints Requirement[] JSON, snapshots to fixtures/
node cli.ts load                           # M2: upsert subgraph + run validate report
node cli.ts run <lcd.pdf> <article.pdf>    # M5: full chain; prints workflow id, then blocks on signal
node cli.ts project <lcdId>                # M4: emits out/<lcdId>.{crd,dtr,plandefinition}.json
```

The Temporal review workflow (`propose → validate → await signal → commit | compensate`) blocks indefinitely on a human `{ decision, reviewer, note }` signal — that block is the feature, not a bug. `src/workflow/client.ts` sends it; M3 tests use `@temporalio/testing`.

## Fixtures the human supplies

`fixtures/L33822.pdf` and `fixtures/A52464.pdf` are "Create PDF" exports from the Medicare Coverage Database. **Do not attempt to fetch them** — the MCD is a dynamic search UI, not a flat store. If absent, fail with a message telling the human to place them.

## Open questions (leave as TODO comments; do not resolve silently)

- Requirement 5 (6-month visit) as its own node vs. a temporal property on Requirement 2 — currently a separate node.
- `DenialReason` in-graph vs. an external validation set — in-graph for the POC.
- CQL is stubbed as a `library` reference; real CQL generation is out of scope.
