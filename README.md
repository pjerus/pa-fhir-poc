# pa-fhir-poc

A proof of concept that turns a Medicare Local Coverage Determination (LCD)
PDF into Da Vinci CRD/DTR/PlanDefinition FHIR artifacts, with a human-gated
review step in between. L33822 (Glucose Monitors) is the demonstration
fixture used throughout this README — the pipeline itself is generic across
any LCD/article pair; see "Add a second LCD" below.

## 1. What this is

The pipeline has four stages: an LLM reads an LCD PDF into structured
requirements, those requirements load into a Neo4j graph alongside the
policy's paired article (ICD-10 codes, HCPCS codes, denial reasons), a
Temporal workflow blocks for a human reviewer to approve or reject the
loaded snapshot, and an approved LCD projects into three FHIR artifacts
(a CRD CDS Hooks card, a DTR Questionnaire, a PlanDefinition).

```
PDF ──▶ LLM extraction ──▶ Neo4j graph ──▶ Temporal human-gated review ──▶ FHIR projection
       (Requirement[])                     (approve | reject)             (CRD / DTR / PlanDefinition)
```

This is intended as a public reference for Da Vinci Project members —
it demonstrates the shape of a PA (prior authorization) pipeline end to end,
not a production service.

## 2. What's proven vs. deliberately deferred

**Proven**, on a real LCD/article pair (L33822 + A52464):

- The full PDF → graph → governed-review → FHIR chain, including the
  Temporal workflow's indefinite block on a human signal.
- Structural R4 validity of the emitted CRD card, DTR Questionnaire, and
  PlanDefinition.
- Correct Da Vinci `meta.profile` tagging: the DTR Questionnaire carries the
  DTR IG v2.2.0 Standard Questionnaire profile. The other two artifacts
  verifiably carry no `meta.profile` — this is not an oversight. The CRD
  CDS Hooks card is not a FHIR resource under CRD v2.2.1 (the spec models
  the response as a logical model), and no Da Vinci CRD/DTR profile exists
  for PlanDefinition.

**Deliberately deferred**, out of scope for this POC:

- Full Da Vinci IG conformance against real `StructureDefinition`s — a
  labeled stretch goal (M6).
- Executable CQL — the PlanDefinition's `library` reference points at a
  stub canonical, not real CQL logic.
- A live CDS Hooks service — nothing here serves the `/cds-services`
  endpoint a real EHR would call.

## 3. Prerequisites

- Node >= 22.18 (type stripping runs TypeScript unbuilt, no build step)
- Docker, for the Neo4j container
- Temporal CLI, for `temporal server start-dev` (or a namespace on a shared
  Temporal — see Setup)
- Ollama running locally with the model named by `EXTRACTION_MODEL`
  (default `qwen3.8:27b`) pulled
- The two source PDFs: `fixtures/L33822.pdf` (the LCD) and
  `fixtures/A52464.pdf` (its paired policy article). These are "Create PDF"
  exports from the Medicare Coverage Database (MCD), a dynamic search UI —
  they cannot be fetched programmatically and are not redistributed in this
  repository. Every stage that needs them fails loudly with the exact path
  it expected if they are absent.

## 4. Setup

```bash
npm install
cp .env.example .env
docker compose up -d
temporal server start-dev
```

A fresh clone's `.env` points `TEMPORAL_NAMESPACE` at `default`, which
`temporal server start-dev` provides. If a Temporal server already occupies
`:7233` on your machine, don't start a second one — create a dedicated
namespace on the existing one instead and point `.env` at it:

```bash
temporal operator namespace create pa-fhir-poc
```

then set `TEMPORAL_NAMESPACE=pa-fhir-poc` in `.env`.

## 5. Run the full chain

Three terminals.

**Terminal A** — start the review worker (blocks; leave it running):

```bash
node src/workflow/worker.ts
```

**Terminal B** — run the full chain on the demonstration fixtures:

```bash
node cli.ts run fixtures/L33822.pdf fixtures/A52464.pdf
```

This extracts both PDFs, starts the review workflow (whose first activity
loads the graph), prints the workflow id, and then blocks. That block is the
durable human gate — the point of the design, not a hang. Nothing projects
until a human signs off.

**Terminal C** — approve the review:

```bash
node cli.ts review-signal review-L33822 approve <your-name>
```

Terminal B then unblocks, projects the approved LCD, and writes
`out/L33822.crd.json`, `out/L33822.dtr.json`, and
`out/L33822.plandefinition.json`.

For finer-grained control, run each stage as its own verb instead of `run`:

```bash
node cli.ts extract fixtures/L33822.pdf
node cli.ts extract-article fixtures/A52464.pdf
node cli.ts load L33822 A52464
node cli.ts review-start L33822 A52464
node cli.ts review-signal <workflowId> approve <your-name>
node cli.ts project L33822
```

## 6. Add a second LCD

The pipeline has no document-specific code — adding another LCD is a
fixtures-only change:

1. Place the LCD PDF at `fixtures/<lcdId>.pdf` and its paired article PDF
   alongside it.
2. Hand-author `fixtures/<lcdId>.expected.json` describing the acceptance
   bar for extraction (requirement count, category distribution, key
   phrases).
3. Run the same commands from "Run the full chain" or the granular verbs,
   substituting the new paths and ids.

No file under `src/` or `cli.ts` changes.

## 7. Testing

```bash
npm test
npm run typecheck
```

`npm test` includes M1's acceptance gate, which runs the live extraction
model against the real L33822 PDF and takes roughly 40 seconds. Graph- and
Temporal-backed tests need `docker compose up -d` and a reachable Temporal
server, per Setup above.

## 8. Graph model

```
(LCD {id, title, version, status, sourceHash})-[:REQUIRES]->(Requirement {id, text, ordinal, category})
(LCD)-[:COVERS]->(Code {system, code})
(LCD)-[:HAS_ARTICLE]->(Article {id, title, version, sourceHash})
(Article)-[:LISTS]->(Code)
(Article)-[:DEFINES]->(DenialReason {id, text})
```

`Article` is its own node because ICD-10 codes and denial reasons are
asserted by the policy article, not the LCD. `Code` is a single label
(not split by system) with a composite key on `(system, code)`, since HCPCS
and ICD-10 are the same kind of thing and FHIR models every coded value as
`{system, code}`.

## 9. License

MIT.
