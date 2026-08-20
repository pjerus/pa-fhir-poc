# POC Plan — LCD → FHIR CRD/DTR Pipeline

**Goal:** Prove the mechanism end-to-end on one Medicare LCD (L33822, Glucose Monitors): take a coverage-policy PDF, extract its discrete requirements into a Neo4j graph, run a durable Temporal review workflow, and project an approved graph node into Da Vinci CRD/DTR FHIR artifacts. Single machine, local models, no proprietary data.

**Intent: this is a public reference repo, not a throwaway.** Build to a standard you'd be comfortable showing a Da Vinci Project member — clean structure, real README, honest tests. L33822 is the acceptance target, but **no code may hardcode its name, codes, or requirement wording**: a second LCD must drop in as fixtures with zero source changes. A pipeline that only works on one document reads as a toy; one where the next document just works reads as real.

**Non-goals for this POC:** production auth, real EHR/CDS-Hooks integration over the wire, clinical accuracy sign-off, executable CQL, full Da Vinci IG conformance (see M6 stretch). This proves the pipeline shape, not a shippable product — but the shape must be genuinely reusable, not L33822-shaped.

---

## Stack

- **Runtime:** Node.js ≥ 22, TypeScript, ESM.
- **Graph:** Neo4j 5.x (Docker, local).
- **Workflow:** Temporal (`temporal server start-dev`, local), `@temporalio/worker` + `@temporalio/client`.
- **LLM extraction:** local only — Qwen3.8:27B via the existing Ollama endpoint (`http://localhost:11434`), model name from env (`EXTRACTION_MODEL`, default `qwen3.8:27b`). No cloud fallback. Keep the LLM call behind one `llm-client.ts` interface anyway — that's clean design, not a swap-in-a-bigger-model hook. Because this single local call is the pipeline's only non-deterministic stage and its only real point of failure, M1's tests and error handling are written to surface extraction weakness loudly (see M1).
- **PDF text:** `unpdf` or `pdfjs-dist` for text extraction. No OCR needed — LCD PDFs are text-based.
- **FHIR:** hand-built JSON resources, validated against **base FHIR R4 structure** and tagged with the correct **Da Vinci CRD/DTR `meta.profile` canonical URLs** (see M4). Full IG-profile conformance is a labeled stretch goal (M6), not a core milestone. `@types/fhir` for R4 types if available; otherwise local minimal types.

Keep every external dependency behind a thin adapter module so none of the four stages hard-couples to a vendor.

---

## Repository layout

```
pa-fhir-poc/
  docker-compose.yml        # neo4j + (optional) temporal
  src/
    extract/
      pdf-text.ts           # PDF path -> plain text + section map
      sections.ts           # heading-based splitter (Indications / Documentation / Limitations)
      structure.ts          # LLM: section text -> Requirement[] (typed)
      llm-client.ts         # single interface over Ollama; swappable
    graph/
      schema.ts             # node/rel type constants + Cypher constraints
      write.ts              # upsert LCD, Code, Requirement, ICD10, DenialReason
      read.ts               # fetch an approved LCD subgraph for projection
      validate.ts           # cycle / duplicate / orphan checks
    workflow/
      activities.ts         # propose, validate, commit, compensate
      review.workflow.ts    # the durable review workflow (signal-gated)
      worker.ts             # registers activities + workflow
      client.ts             # start workflow, send approve/reject signal
    fhir/
      crd.ts                # graph -> CDS Hooks card JSON
      dtr.ts                # graph -> Questionnaire (+ CQL stub)
      plandefinition.ts     # graph -> PlanDefinition JSON
    types.ts                # shared domain types (Requirement, Code, etc.)
    cli.ts                  # orchestration entrypoint (see Milestones)
  fixtures/
    L33822.pdf              # placed by human — see "Inputs the human provides"
    A52464.pdf              # placed by human
    L33822.expected.json    # hand-authored ground truth (5 requirements)
    # fixtures are keyed by LCD id; a second LCD is a new trio of files, no code change
  test/
    *.test.ts               # node --test
  README.md
```

---

## Inputs the human provides

Do **not** fetch these from the network — the Medicare Coverage Database is a dynamic search UI, not a flat store. The human will place two files in `fixtures/`:

- `L33822.pdf` — the "Create PDF" export of LCD L33822 from the Medicare Coverage Database.
- `A52464.pdf` — the "Create PDF" export of Policy Article A52464 (holds the ICD-10 codes + denial reasons).

If these files are absent when a stage runs, fail with a clear message telling the human to place them — never stub them silently.

---

## Domain model (target graph shape)

The model is LCD-agnostic — no node type or property encodes anything specific to L33822. Literals below are illustrative examples drawn from L33822, not hardcoded values.

Nodes:
- `LCD` — `{ id, title, version, status: "draft"|"approved", sourceHash }` (e.g. `id: "L33822"`)
- `Code` — `{ system, code }` (e.g. `{ "HCPCS", "K0554" }`)
- `Requirement` — `{ id, text, ordinal, category }` (category ∈ indication|documentation|limitation)
- `ICD10` — `{ code }` (from the paired policy article)
- `DenialReason` — `{ id, text }` (e.g. `id: "GL032"`)

Relationships:
- `(LCD)-[:COVERS]->(Code)`
- `(LCD)-[:REQUIRES]->(Requirement)`
- `(Requirement)-[:DIAGNOSIS_OF]->(ICD10)`
- `(Requirement)-[:FAILS_AS]->(DenialReason)`

`sourceHash` = sha256 of the extracted source text, so a re-run detects whether the underlying PDF changed. `status` gates projection: only `approved` LCDs may be projected to FHIR.

For L33822 specifically, the acceptance target is its five requirements (diabetes dx, insulin/pump use, testing frequency, level-3 hypoglycemic event, 6-month provider visit) — but these live in `fixtures/L33822.expected.json`, **not in source code**. Exact wording comes from the PDF; the expected file is ground truth for structure, not prose.

---

## Milestones (each independently runnable + testable)

Build in this order. Each milestone ends with a runnable CLI verb and passing tests. Do not start a milestone before the previous one's tests pass.

### M1 — Extraction to typed `Requirement[]`
- `cli.ts extract <path-to-pdf>` prints structured JSON. The verb takes any LCD PDF path — nothing about L33822 is baked in.
- `pdf-text.ts` → raw text. `sections.ts` → `{ indications, documentation, limitations }` via generic heading heuristics that work across MAC formatting (log a warning, don't crash, if a section isn't found).
- `structure.ts` calls the LLM (Qwen3.8:27B, local) with a strict prompt: return **only** JSON matching the `Requirement[]` schema, no prose, no markdown fences. Validate the parse against the schema; on malformed output, retry **once** with a sharper instruction; on a second failure, **throw with the raw model output in the error** so the human can see exactly how Qwen fell short. Never emit partial or fabricated requirements to make the stage appear to succeed.
- **Snapshot:** on success, write the extraction result to `fixtures/<lcdId>.extracted.json`. M2–M4 tests read this snapshot, never re-invoke the LLM — this quarantines the one non-deterministic stage.
- **Test:** against `fixtures/<lcdId>.expected.json`, assert requirement **count** and **category distribution** match, and that each expected requirement's key phrase appears somewhere in an extracted requirement. Do **not** assert exact prose (Qwen will drift). Because extraction is local-only with no fallback, this test is the honest gate: if Qwen3.8:27B can't hit it reliably, that's a finding to surface now — not something to paper over by loosening the assertion until it passes.

### M2 — Graph write + validate
- `cli.ts load` takes the M1 output + A52464 codes and upserts the full subgraph.
- `schema.ts` creates uniqueness constraints on `LCD.id`, `Code.code`, `Requirement.id`.
- `validate.ts` runs after write: no cycles among requirements, no duplicate requirement text, no orphan `ICD10`/`DenialReason` nodes. Return a structured report.
- **Test:** load, then query back the 5 `REQUIRES` edges + 2 `COVERS` edges; assert `validate` returns clean.

### M3 — Temporal durable review
- `review.workflow.ts`: `propose → validate → await signal → commit | compensate`. The signal carries `{ decision: "approve"|"reject", reviewer, note }`.
- Workflow blocks indefinitely on the signal (this is the point — durable human gate). On `approve`, flip `LCD.status` to `approved` via the commit activity. On `reject`, run compensation (leave status `draft`, record the note) and end.
- `client.ts` exposes `start <lcdId>` and `signal <workflowId> approve|reject`.
- **Test:** use Temporal's TS test env (`@temporalio/testing`) — start workflow, assert it's waiting, send approve signal, assert `LCD.status == approved`. Second test: reject path leaves status `draft`.

### M4 — FHIR projection (structural + Da Vinci profile tags)
- `cli.ts project <lcdId>` reads the **approved** subgraph and emits three files: `out/<lcdId>.crd.json`, `out/<lcdId>.dtr.json`, `out/<lcdId>.plandefinition.json`. Refuse to project a `draft` LCD.
- `crd.ts` → a CDS Hooks card ("PA/documentation required for <code>; see requirements"), built from graph data — no hardcoded codes.
- `dtr.ts` → a FHIR R4 `Questionnaire` with one item per `documentation`-category requirement; CQL as a stubbed `library` reference for now (real CQL is M6/out of scope).
- `plandefinition.ts` → a `PlanDefinition` linking the covered codes to the questionnaire.
- **Profile tags:** every emitted resource carries the correct Da Vinci CRD/DTR `meta.profile` canonical URL(s). This signals to anyone from that community that the IG targets are known and deliberate, even though full conformance is deferred. Put the canonical URLs in one `fhir/profiles.ts` constant so M6 can tighten against them.
- **Test:** structural assertions against base FHIR R4 — correct `resourceType`, `meta.profile` present and matching the expected canonical, questionnaire item count == documentation-requirement count, covered codes present, and projecting a `draft` LCD throws. Validation is structural (shape + profile tag), **not** full IG-profile conformance.

### M5 — End-to-end glue + README
- `cli.ts run <lcd-pdf> <article-pdf>` chains M1→M2→M3(start)→ prints the workflow id → human signals approve → `project` runs. Works for any LCD/article pair, demonstrated on L33822.
- README documents: prerequisites, `docker compose up`, `temporal server start-dev`, the env vars, the exact command sequence, the one manual step (the signal) explicitly, and **a short "add a second LCD" section** proving the generic claim (place three fixture files, run `run` — no code change).
- README states plainly what's proven (PDF→graph→governed→FHIR shape) and what's deliberately deferred (IG conformance, executable CQL, live CDS-Hooks) — scoping the gaps out on purpose reads as competence; leaving them unaddressed reads as not knowing they exist.

### M6 — (stretch, not required for done) Da Vinci IG conformance
- Validate emitted resources against the actual Da Vinci CRD/DTR StructureDefinitions (not just base R4 + a profile tag).
- Only start after M1–M5 are green and committed. Labeled clearly in the README as a stretch goal so a reader sees the IG was scoped, not missed.

---

## Conventions the agent must follow

- **TypeScript strict.** No `any` in domain types. Every LLM/PDF/graph boundary is a typed adapter.
- **No shell-string interpolation.** Any child process uses array args, `shell: false`.
- **No secrets in code or logs.** Neo4j creds and the model endpoint come from env (`.env.example` committed, `.env` gitignored).
- **Fail loud, never stub silently.** Missing fixtures, malformed LLM output, or a draft-status projection must throw with an actionable message — do not fabricate placeholder data to make a stage "pass."
- **Deterministic where possible.** The graph and FHIR stages must be pure functions of their inputs; only the extraction stage is allowed to be non-deterministic (LLM), and its output is snapshotted for downstream tests.
- **Generic across LCDs, always.** No source file may hardcode `L33822`, its HCPCS codes, its requirement wording, or its denial codes. All document-specific data enters through `fixtures/` keyed by LCD id. The test suite proves this by construction; a reviewer should be able to add a second LCD without opening `src/`.
- **Tests are `node --test`**, colocated, runnable with `npm test`. Every milestone's tests must pass before the next begins.
- **Commit per milestone** with a message naming the milestone and what its tests cover.

## Definition of done

`npm test` green across M1–M5; `cli.ts run` completes the full chain on L33822 after a manual approve signal; `out/` contains three FHIR resources that are R4-structurally valid, carry correct Da Vinci `meta.profile` tags, and trace back to the extracted requirements. The README lets a fresh clone reproduce it **and** shows how to add a second LCD with no code change. M6 (full IG conformance) is explicitly out of the done bar — it's a labeled stretch goal.

## Open modeling questions (leave as TODO comments, don't resolve silently)

- Should Requirement 5 (6-month visit) be its own node or a temporal property on Requirement 2? (Left as separate node for now.)
- Should `DenialReason` live in the graph or be an external validation set? (In-graph for the POC; revisit at scale.)
- CQL is stubbed — real CQL generation is out of scope for this POC.
