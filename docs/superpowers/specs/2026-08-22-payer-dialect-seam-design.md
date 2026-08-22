# Payer dialect seam — design

Date: 2026-08-22
Status: decisions settled in brainstorm; awaiting spec review
Visual companion: https://claude.ai/code/artifact/b151d363-9b6b-4a7d-92e8-2bbdd2ef944c

## Goal

Admit a third fixture — Cigna Medical Coverage Policy 0158 — to prove the
pipeline generalizes past the CMS MAC template to a commercial payer. One
pipeline, per-publisher **dialect profiles** plugged in at the two stages
that read document structure. Everything downstream of extraction already
consumes payer-neutral shapes (`Requirement[]`, `Code[]`) and stays
untouched except where the graph decisions below say otherwise.

A dialect covers a publisher *format*, not a plan or a document: one
dialect for all MAC LCDs/articles, one for all Cigna coverage policies.
Each new payer format is a new dialect — that is the honest cost of the
design.

## Evidence (verified 2026-08-22 against the live document)

The live 0158 at static.cigna.com is **"Surgical Treatments for
Obstructive Sleep Apnea"** — 32 pages, effective 6/15/2026. The
2026-08-22 checkpoint's "~54pp OSA/CPAP" description is stale: Cigna
narrowed 0158 to surgical treatments; CPAP/diagnosis moved to a separate
"Sleep Disordered Breathing Diagnosis and Treatment Guidelines" document
(eviCore-hosted). The 54-page combined version survives only on
third-party mirrors — unstable sources, unfit for a public reference
repo. The fixture targets the live surgical-OSA policy.

Grammar deltas vs. the MAC template:

- **Single document.** No paired article; codes and non-coverage
  statements live in the policy itself.
- **Section headings**: Overview / Coverage Policy / Coding Information /
  General Background / Health Equity Considerations / References /
  Revision Details. "Coverage Policy" mixes indications and limitations.
  There is **no documentation-requirements section**.
- **Zero ICD-10 codes** anywhere in the document.
- **CPT codes** appear — a third code system beside HCPCS and ICD-10-CM.
- **Code tables are stance-stratified and each table is headed by the
  stance statement itself** ("Considered Not Medically Necessary when
  used to report uvulectomy as a stand-alone procedure…: 42140"). The
  code↔statement grouping is *stated by the document* — the trigger
  condition the deferred-edge TODO in `schema.ts` anticipated.
- "Revision Details" is terminal boilerplate, analogous to MAC's
  "Revision History".

## Decisions

### D1 — Single-document facts hang on the policy node

The article becomes optional. For Cigna there is no `Article` node; the
policy node itself gets `DEFINES` edges (and keeps `COVERS`). This
matches the graph's founding principle: each fact hangs on the document
that asserts it. A synthetic mirror Article was rejected (fabricates a
document); generalizing to `(:Document {role})` was rejected for the POC
(restructures M2–M4 to serve one fixture — revisit if a fourth format
strains this).

Verified downstream impact — three touch points, nothing else:

1. `src/graph/read.ts` anchors its DEFINES query on `(:Article {id})`
   and nests `denialReasons` under `article?`. **Hoist `denialReasons`
   to the top level of `ApprovedSubgraph`** (sourced from whichever node
   DEFINES them); `article?` keeps only what the article itself asserts
   (id, sourceHash, listedCodes).
2. `src/graph/write.ts` `upsertDenialReasons` takes an ArticleInput
   anchor — parameterize the anchor node.
3. `src/ui/index.html` renders the denial list only inside the
   `subgraph.article` block — read the hoisted field.

Zero impact, verified: the FHIR projection consumes nothing article- or
denial-related; `validate.ts` orphan checks use anonymous relationship
sources (`(()-[:DEFINES]->)`); the review workflow is untouched.

### D2 — Stance statement is the concept; codes hang off it

Cigna's table heading and its code list are one categorical statement
expressed twice: the prose is the description, the table provides the
codes. Model it that way:

- MN table → `(:LCD)-[:COVERS]->(Code)` unchanged — "covered when the
  criteria above are met" is the existing model of coverage conditional
  on requirements.
- Each not-MN / experimental-investigational-unproven statement →
  `(:LCD)-[:DEFINES]->(DenialReason {id, text, stance})`, with
  `stance ∈ {not-medically-necessary, experimental-investigational}`
  (absent on MAC-sourced denial reasons).
- That statement's table codes → `(DenialReason)-[:APPLIES_TO]->(Code)`.
  A stated fact, not an inference. The MAC dialect never emits
  APPLIES_TO — its documents don't state the link.

No separate EXCLUDES edge: excluded codes are reachable through the
statement that excludes them (also the path a CRD card would narrate:
"42140 will be denied: <reason text>"). A flat stance property on COVERS
was rejected — a forgotten `WHERE` filter would silently project
excluded codes into the PlanDefinition.

**Dual-stance wrinkle (record in extraction ground truth):** the main
Cigna table's heading carries two stances — MN for sleep apnea, not-MN
"for the treatment of snoring in the absence of sleep apnea". The MN
half maps to COVERS; the snoring half is a DenialReason whose
APPLIES_TO spans that whole table.

Schema deltas: new `APPLIES_TO` relationship constant; `DenialReason`
gains optional `stance`; the `schema.ts` deferred-edge TODO is updated
to note APPLIES_TO landed for the stated-grouping case while
DIAGNOSIS_OF / FAILS_AS remain deferred.

### D3 — Fixture identity, dialect selection, document-set arity

- **Fixture id `CIGNA-0158`** (file `fixtures/CIGNA-0158.pdf`),
  keeping id-from-filename intact. Payer slug is legible to the Da Vinci
  audience and immune to cross-payer number collisions ("CP" and bare
  4-digit numbers are not Cigna-specific).
- **Dialect is sniffed from page 1** — MAC documents open with a literal
  "Local Coverage Determination (LCD)" (articles: "Article") banner;
  Cigna's open with "Medical Coverage Policy" plus a "Coverage Policy
  Number… 0158" field. Exactly one dialect must match; none or both →
  loud error naming the known dialects. No CLI flag, including the
  review-console upload path.
- **Id cross-check**: the banner parse holds the document's own number,
  so each dialect verifies the filename-derived id against it (MAC:
  L/A-number verbatim; Cigna: numeric part of `CIGNA-NNNN`). Mismatch
  fails at intake with an actionable message.
- **Arity from the dialect**: MAC requires a paired article; Cigna
  forbids one. `run <policy.pdf> [article.pdf]` (and the UI upload)
  validate the supplied set against the sniffed dialect.

### D4 — DTR Questionnaire: empty now, derive later

CIGNA-0158 projects an **empty Questionnaire**, documented as an honest
finding: the source states no documentation obligations, and the empty
artifact is proof the pipeline generalized rather than fabricated.
Indication-sourced Questionnaire items (each attestable criterion — e.g.
"documentation that demonstrates PAP treatment failure…" — becomes an
item) are the next design, deliberately out of this task's scope; they
would improve all three fixtures, since the MAC documentation sections
are shared boilerplate.

### Distribution — the Cigna PDF is not committed

CMS documents are public-domain US-government works; Cigna coverage
policies are copyrighted. For a public reference repo, do not commit
`CIGNA-0158.pdf`. Ship `tools/fetch-cigna-0158.sh` (curl of the stable
static.cigna.com URL, precedent: `tools/fetch-validator.sh`) and
gitignore the PDF. If the PDF is absent, fail with the existing
tell-the-human-to-fetch message pattern. The reviewed snapshots
(`CIGNA-0158.extracted.json`, `.expected.json`) are committed as our own
derived ground truth, quoting requirement-scale excerpts only.

Note: Cigna revises policies on a review cycle (next review 12/15/2026);
the fetch script pins expectations to the fixture's `sourceHash`, and a
changed upstream PDF surfaces as a hash mismatch, not silent drift.

## Dialect profile shape

`src/extract/dialects/{mac,cigna}.ts`, selected by the sniffer. Exact
interface is the implementation plan's to pin; the responsibilities are:

- **Sniff**: match page-1 banner; return the document's self-declared
  number for the id cross-check.
- **Section specs**: heading pattern → section name → allowed
  requirement categories, plus **boundary-only headings** (recognized as
  section ends but extracted from never) — for Cigna: Overview, Coding
  Information, General Background, Health Equity Considerations,
  References. The `sections.ts` mechanism (structural heading detection,
  recurrence caps) is unchanged; only its vocabulary moves into the
  dialect, and the terminal-cut heading ("Revision History" vs
  "Revision Details") becomes dialect-supplied.
- **Code-table grammar**: table headings, code shapes (HCPCS
  `^[A-Z]\d{4}$`, CPT `^\d{4}[0-9A-Z]$`), and — for Cigna — the
  stance carried by each table's heading statement, feeding D2's
  COVERS / DenialReason+APPLIES_TO split.
- **Document-set shape**: article `required` (MAC) | `none` (Cigna).
- **Prompt naming**: the LLM prompt's "Medicare coverage policy" phrase
  becomes the dialect's document name.

Cigna's "Coverage Policy" section maps to indication + limitation as one
block — the existing multi-category block mechanism (built for MAC's
combined heading) applies as-is, including the category-definitions
prompt.

`src/fhir/profiles.ts` `codeSystemUri()` gains CPT
(`http://www.ama-assn.org/go/cpt` — verify against THO at
implementation time, as was done for HCPCS).

## Testing

Same discipline as the existing fixtures:

- Sniffer and id cross-check: unit tests on inline page-1 strings for
  both dialects, plus the none/both failure modes.
- Cigna section vocabulary: tests that boundary-only headings stop
  section bodies (General Background must not bleed into Coverage
  Policy) — the L33718 lesson, applied per dialect.
- Code-table grammar: tests on text snippets from the real document —
  stance table splitting, the dual-stance main table, CPT/HCPCS shapes.
- Graph round-trip: policy-anchored DEFINES + APPLIES_TO written and
  read back; `ApprovedSubgraph` hoisted shape; MAC fixtures re-verified
  unchanged through the same read path.
- M1 acceptance gate: `fixtures/CIGNA-0158.expected.json` joins the
  live-model gate in `npm test`; ground truth derived by line-by-line
  review of the extraction against the source PDF, as for both MACs.
- `npm test` stays free of Docker/Java/network; absent PDF fails with
  the fetch-script message.

## Out of scope

- Indication-sourced DTR Questionnaire items (next design; backlog).
- `(:Document {role})` generalization; DIAGNOSIS_OF / FAILS_AS edges.
- ICD-10 for Cigna (the document has none — an empty diagnosis list is
  the faithful result).
- The eviCore "Sleep Disordered Breathing" guideline as a fixture.
