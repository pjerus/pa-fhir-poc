# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Read `PA-AI-POC-PLAN.md` in full before writing code — it is the authority on scope, milestone ordering, and the acceptance bar.

**Current milestone: M1-M3 complete and verified on the real documents; M4 (FHIR projection) is next.** The graph holds approved L33822: 37 requirements, 20 covered HCPCS codes, 461 article-listed ICD-10 codes, 16 denial reasons — all via `node cli.ts load L33822 A52464` + the review workflow. M1's acceptance gate now runs the live model (~40s) inside `npm test`.

M3 facts: the review workflow runs against the machine's shared Temporal at :7233, namespace `pa-fhir-poc` (env-driven; fresh clones use `temporal server start-dev` + `default`). Worker: `node src/workflow/worker.ts`. Review provenance lands on the LCD node as `lastReviewDecision`/`lastReviewer`/`lastReviewNote`.

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

**This supersedes the plan's "Domain model" section.** The plan's version is the starting point; the three changes below were agreed deliberately and must not be silently reverted to match the plan.

```
(LCD {id, title, version, status, sourceHash})-[:REQUIRES]->(Requirement {id, text, ordinal, category})
(LCD)-[:COVERS]->(Code {system, code})
(LCD)-[:HAS_ARTICLE]->(Article {id, title, version, sourceHash})
(Article)-[:LISTS]->(Code)
(Article)-[:DEFINES]->(DenialReason {id, text})
```

Constraints: uniqueness on `LCD.id`, `Article.id`, `Requirement.id`; composite node key on `(Code.system, Code.code)`.

1. **`Article` is a node.** ICD-10 codes and denial reasons come from a paired policy article PDF (A52464 for L33822), not the LCD. Giving the article a node puts each fact on the thing that asserts it. `Article.sourceHash` detects a changed article PDF independently of the LCD's.

2. **One `Code` label, not `Code` + `ICD10`.** HCPCS and ICD-10 are the same kind of thing, and FHIR models every coded value as `{system, code}`, so a unified node projects straight through in M4. This is why the uniqueness constraint is composite — a bare constraint on `Code.code` (as the plan specifies) lets an ICD-10 code string collide with an HCPCS one.

3. **`(Requirement)-[:DIAGNOSIS_OF]->` and `[:FAILS_AS]->` are deliberately not implemented.** The plan hangs these off individual requirements, but the article lists codes and denial reasons for the policy as a whole — attaching them per-requirement would mean inventing a fact neither document states. Nothing in M4 consumes them: the CRD card needs HCPCS codes plus requirements, the DTR Questionnaire needs documentation-category requirements, the PlanDefinition needs covered codes. Add these edges only if a policy article turns out to group its code lists under criteria headings, which would make the grouping a stated fact rather than an inference. Leave a TODO in `schema.ts`.

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
node cli.ts load <lcdId> [articleId]        # M2, implemented: snapshot -> graph upsert -> validation report (exit 1 if unclean)
node src/workflow/worker.ts                 # M3, implemented: review worker (blocks; run in its own terminal)
node cli.ts review-start <lcdId> [articleId]        # M3, implemented: starts review workflow, prints workflow id
node cli.ts review-signal <wfId> <approve|reject> <reviewer> [note]   # M3, implemented
node cli.ts extract-article <article.pdf>   # M2, implemented: ICD-10/HCPCS deterministic + denial reasons via LLM -> fixtures/<id>.article.json
```

Not yet implemented — the interface the plan commits to:

```bash
docker compose up -d                        # neo4j (see "Neo4j" below)
temporal server start-dev                   # temporal dev server
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
- **Cross-system code translation is unbuilt.** A FHIR `CodeableConcept` carries an array of `Coding`s expressing *one* concept in several code systems (ICD-10-CM and SNOMED CT for the same diagnosis, say). The graph currently has no notion of a concept distinct from a code, so it cannot say two codes are equivalent, and every projected concept will carry exactly one coding. Doing this properly means a concept layer plus a real translation source (a FHIR `ConceptMap` / terminology server `$translate`), which is out of scope alongside CQL. **Consequence for M4: emit `CodeableConcept` with a one-element `coding` array, never a bare `Coding`** — then adding translations later is purely additive and no consumer changes.
- Whether `Code.system` stores a short name (`HCPCS`) or the canonical FHIR system URI. Short names read better in the Neo4j browser; canonical URIs project without a lookup. Either way the URIs belong in one module next to `src/fhir/profiles.ts`, and they need verifying against the spec rather than recalled — HCPCS in particular has more than one plausible canonical.
