# pa-fhir-poc

A proof of concept that turns a Medicare Local Coverage Determination (LCD)
PDF into Da Vinci CRD/DTR FHIR artifacts, with a durable human-gated review
between extraction and publication. Built as a public reference for Da Vinci
Project members: it demonstrates the shape of a prior-authorization pipeline
end to end — not a production service.

L33822 (Glucose Monitors, article A52464) and L33718 (PAP Devices for
Obstructive Sleep Apnea, article A52467) are the demonstration fixtures; the
pipeline is generic across any LCD/article pair, and the second pair was
added exactly as [add a second LCD](#8-add-a-second-lcd) prescribes — a
fixtures-only change, no document-specific code.

```mermaid
flowchart LR
    PDF["LCD + article PDFs"] --> EX["LLM extraction<br/>(Ollama, local only)"]
    EX --> SNAP["fixtures/ snapshots<br/>(deterministic boundary)"]
    SNAP --> G[("Neo4j graph")]
    G --> REV{"Temporal review<br/>human approve / reject"}
    REV -->|approved| PROJ["FHIR projection"]
    REV -->|rejected| COMP["compensate"]
    PROJ --> CRD["CRD CDS Hooks card"]
    PROJ --> DTR["DTR Questionnaire"]
    PROJ --> PD["PlanDefinition"]
    DTR -.-> VAL["HL7 validator<br/>dtr-std-questionnaire"]
    PD -.-> VAL
```

The LLM extraction is the only non-deterministic stage, and it is quarantined
behind a snapshot: everything downstream is a pure function of its inputs.
The Temporal workflow blocks indefinitely on a human signal — that block is
the governance feature, not a hang. Nothing reaches FHIR without a named
reviewer's approval, recorded on the graph.

## 1. See the output without running anything

The three artifacts projected from each reviewed graph are committed as
[`docs/examples/`](docs/examples/), for both demonstration LCDs:

- [`L33822.dtr.json`](docs/examples/L33822.dtr.json) /
  [`L33718.dtr.json`](docs/examples/L33718.dtr.json) — DTR Questionnaire, one
  boolean attestation item per documentation requirement.
- [`L33822.crd.json`](docs/examples/L33822.crd.json) /
  [`L33718.crd.json`](docs/examples/L33718.crd.json) — CRD CDS Hooks card:
  covered HCPCS codes plus the requirement text a clinician would see.
- [`L33822.plandefinition.json`](docs/examples/L33822.plandefinition.json) /
  [`L33718.plandefinition.json`](docs/examples/L33718.plandefinition.json) —
  PlanDefinition linking each covered code to the questionnaire.

## 2. What's proven vs. deliberately deferred

**Proven**, on two real LCD/article pairs (L33822 + A52464, L33718 + A52467):

- The full PDF → graph → governed-review → FHIR chain, including the
  workflow's indefinite block on the human signal.
- **Generality**: the second pair (PAP devices — different clinical domain,
  1 article-listed ICD-10 code where glucose monitoring has 461) went through
  as a fixtures-only change. It also did exactly what a second document
  should: it exposed two generic pipeline defects (PDF line-wrap fragments
  masquerading as section headings; "covered codes" harvested from prose),
  both fixed for all documents with regression tests — see
  [`docs/conformance/L33718.md`](docs/conformance/L33718.md).
- **IG conformance by the official HL7 validator** (M6), for both LCDs: each
  DTR Questionnaire validates against the DTR IG v2.2.0
  `dtr-std-questionnaire` StructureDefinition with **0 errors, 0 warnings**;
  each PlanDefinition against base R4 with 0 errors. Full reports, flags, and
  rationale: [`docs/conformance/`](docs/conformance/).
- Correct absence of profiles where none exist: the CRD CDS Hooks card is a
  logical model under CRD v2.2.1 (not a FHIR resource), and no Da Vinci
  CRD/DTR profile exists for PlanDefinition. Both are verified findings, not
  oversights.

**Deliberately deferred** (see [`docs/backlog.md`](docs/backlog.md)):

- Executable CQL — the questionnaire's `library` reference is a stub
  canonical.
- A live CDS Hooks service — nothing serves the `/cds-services` endpoint an
  EHR would call.
- Terminology validation — the validator runs `-tx n/a`; HCPCS and ICD-10-CM
  aren't freely distributable as FHIR CodeSystem content.
- An in-process Zod conformance guardrail (fhir-zod-gen) — seam designed,
  blocked on upstream tooling.

## 3. Graph model

```mermaid
flowchart LR
    LCD["LCD<br/>{id, title, version, status, sourceHash}"] -->|REQUIRES| REQ["Requirement<br/>{id, text, ordinal, category}"]
    LCD -->|COVERS| CODE["Code<br/>{system, code}"]
    LCD -->|HAS_ARTICLE| ART["Article<br/>{id, title, version, sourceHash}"]
    ART -->|LISTS| CODE
    ART -->|DEFINES| DR["DenialReason<br/>{id, text}"]
```

`Article` is its own node because ICD-10 codes and denial reasons are
asserted by the policy article, not the LCD — each fact lives on the document
that states it. `Code` is a single label with a composite key on
`(system, code)`: HCPCS and ICD-10 are the same kind of thing, and FHIR
models every coded value as `{system, code}`, so a unified node projects
straight through. Review provenance (`lastReviewDecision`, `lastReviewer`,
`lastReviewNote`) lands on the LCD node; only an `approved` LCD may project —
projecting a draft throws.

## 4. Prerequisites

- Node >= 22.18 (type stripping runs TypeScript unbuilt, no build step)
- Docker, for the Neo4j container (and the optional conformance validator)
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

## 5. Setup

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

## 6. Run the full chain

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

## 7. Validate conformance (optional — M6)

The committed evidence in [`docs/conformance/L33822.md`](docs/conformance/L33822.md)
already shows the verdicts; nothing below is required to use the repo. To
reproduce them with the official HL7 validator (Docker runs it — no local
Java needed):

```bash
./tools/fetch-validator.sh     # once; downloads the pinned validator_cli.jar
node cli.ts validate L33822
```

The first run downloads the DTR IG package tree into `.fhir/` (gitignored);
later runs are offline. The Questionnaire is validated against
`dtr-std-questionnaire` from `hl7.fhir.us.davinci-dtr#2.2.0`, the
PlanDefinition against base R4, and the CRD card is reported as skipped with
the reason (it is a CDS Hooks logical model, not a FHIR resource).

## 8. Add a second LCD

The pipeline has no document-specific code — adding another LCD is a
fixtures-only change. (This is not just a claim: L33718/A52467 was added this
way — see [`docs/conformance/L33718.md`](docs/conformance/L33718.md).)

1. Place the LCD PDF at `fixtures/<lcdId>.pdf` and its paired article PDF
   alongside it.
2. Hand-author `fixtures/<lcdId>.expected.json` describing the acceptance
   bar for extraction (requirement count, category distribution, key
   phrases).
3. Run the same commands from "Run the full chain" or the granular verbs,
   substituting the new paths and ids — including `validate <lcdId>` if you
   want the conformance verdict.

No file under `src/` or `cli.ts` changes.

## 9. Testing

```bash
npm test
npm run typecheck
```

`npm test` includes M1's acceptance gate, which runs the live extraction
model against the real L33822 PDF and takes roughly 40 seconds. Graph- and
Temporal-backed tests need `docker compose up -d` and a reachable Temporal
server, per Setup above. The validator is deliberately **not** part of
`npm test` — its deterministic surface is tested, but no test needs Docker,
Java, or the network.

## 10. Repository tour

- `src/extract/` — PDF → text → sections → LLM → `Requirement[]`; the only
  Ollama-aware file is `llm-client.ts`
- `src/graph/` — schema/constraints, upsert, approved-subgraph read,
  validation report
- `src/workflow/` — Temporal review workflow, activities, worker, client
- `src/fhir/` — the three artifact builders, `profiles.ts` (sole home of
  every canonical URL), `validate.ts` (M6 runner)
- `cli.ts` — the single orchestration entrypoint for every verb above
- `docs/examples/` — committed artifacts; `docs/conformance/` — validator
  evidence; `docs/backlog.md` — deliberate deferrals; `docs/plans/` —
  per-milestone implementation plans
- `PA-AI-POC-PLAN.md` — the original scope and milestone plan

## 11. License

[MIT](LICENSE).
