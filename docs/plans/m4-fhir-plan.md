# M4 plan — FHIR projection (structural + Da Vinci profile tags)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One implementer per task, in order; each task ends with green `npm run typecheck` + its own tests, and a plain-message commit.

**Goal:** `node cli.ts project <lcdId>` reads the approved subgraph and emits `out/<lcdId>.{crd,dtr,plandefinition}.json` — pure functions of `ApprovedSubgraph`, structurally valid base R4, correct Da Vinci canonicals.

**Spec:** PA-AI-POC-PLAN.md (M4) + CLAUDE.md ("Open questions" — the CodeableConcept rule is binding).

## Verified canonicals (fetched from spec sources 2026-08-20 — do not "correct" from memory)

- DTR Standard Questionnaire profile (DTR IG v2.2.0): `http://hl7.org/fhir/us/davinci-dtr/StructureDefinition/dtr-std-questionnaire`
- HCPCS Level II code system (THO v7.3.0 external code systems): `http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets` (yes, plain `http`, with `www` — that is what THO publishes)
- ICD-10-CM code system (THO v7.3.0): `http://hl7.org/fhir/sid/icd-10-cm`
- cqf-library extension (FHIR R4 core): `http://hl7.org/fhir/StructureDefinition/cqf-library`
- **Findings, encoded honestly:** CRD v2.2.1 models the CDS Hooks response as a *logical model* (`CRDHooksResponse`) — a CDS Hooks card is JSON, not a FHIR resource, so `crd.json` carries **no** `meta.profile`. Neither CRD nor DTR v2.2 profiles `PlanDefinition`, so `plandefinition.json` is base R4 with **no** `meta.profile`. Do not invent canonicals for either; each gets a short comment stating the verified absence. Only the Questionnaire is profile-tagged.

## Global Constraints

- TypeScript strict, ESM, Node type stripping: `.ts` import extensions, `erasableSyntaxOnly` (no enums/namespaces/parameter properties). `npx tsc --noEmit` clean.
- No document-specific data in `src/`: no `L33822`, no real HCPCS/ICD-10 codes. Test fixtures use the repo's fabricated unassigned-range codes convention (HCPCS like `E9819`/`K9813`, ICD-10-CM like `E99.1`). Taken graph-test namespaces: `TEST-W- V- R- C- X- F- C3-`; this plan uses `TEST-P-` (cli project test).
- Fail loud. Tests `node --test`, colocated for `src/`, `test/` for cli. Commit per task, plain messages, **no Co-Authored-By trailer**.
- New dev dep: `@types/fhir` (latest). Used **only** via `import type` from `'fhir/r4'` (erased at runtime — no runtime `fhir` package exists or is needed). No `any` in domain types.
- The three builders are **pure functions of `ApprovedSubgraph`** (`src/graph/read.ts`) — no I/O, no Date, no randomness. Requirements arrive already ordered by ordinal; preserve that order.
- **CodeableConcept rule (binding, CLAUDE.md):** every coded value in emitted FHIR is a `CodeableConcept` with a one-element `coding` array — never a bare `Coding`, never multiple codings. This is why PlanDefinition links codes via `action[].code` (a `CodeableConcept[]`), not `DataRequirement.codeFilter` (whose `code` is `Coding[]`).

## Design (binding)

`src/fhir/profiles.ts` is the only home of canonical URLs:

```ts
export const DTR_STD_QUESTIONNAIRE_PROFILE = 'http://hl7.org/fhir/us/davinci-dtr/StructureDefinition/dtr-std-questionnaire';
export const CQF_LIBRARY_EXTENSION = 'http://hl7.org/fhir/StructureDefinition/cqf-library';
const CODE_SYSTEM_URIS: Readonly<Record<string, string>> = {
  'HCPCS': 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets',
  'ICD-10-CM': 'http://hl7.org/fhir/sid/icd-10-cm',
};
export function codeSystemUri(system: string): string   // unknown system -> throw naming it and the known ones
export const CANONICAL_BASE = 'http://example.org/pa-fhir-poc';  // POC-owned instance canonicals; example.org on purpose
export function instanceCanonical(resourceType: string, id: string): string  // `${CANONICAL_BASE}/${resourceType}/${id}`
```

Graph `Code.system` holds short names (`'HCPCS'`, `'ICD-10-CM'`) — `codeSystemUri` is the one lookup point (this resolves CLAUDE.md's open question in favor of short names in-graph, URIs at projection; note that in the profiles.ts header comment).

Shared instance canonicals: Questionnaire → `instanceCanonical('Questionnaire', lcdId)`; CQL stub → `instanceCanonical('Library', `${lcdId}-cql-stub`)` (TODO comment: real CQL out of scope). PlanDefinition → `instanceCanonical('PlanDefinition', lcdId)`.

- `src/fhir/dtr.ts` — `buildDtrQuestionnaire(subgraph: ApprovedSubgraph): fhir4.Questionnaire`. `resourceType 'Questionnaire'`, `id: lcdId`, `meta.profile: [DTR_STD_QUESTIONNAIRE_PROFILE]`, `url` per above, `version: lcd.version` (omit if absent), `title: lcd.title` (omit if absent), `name: lcdId`, `status: 'active'` (only approved LCDs reach projection), `extension: [{ url: CQF_LIBRARY_EXTENSION, valueCanonical: <library stub> }]`, `item`: one per **documentation-category** requirement in ordinal order — `{ linkId: requirement.id, text: requirement.text, type: 'boolean' }` (boolean = "is this documented?" attestation; a real DTR form would prepopulate via CQL — TODO comment).
- `src/fhir/crd.ts` — CDS Hooks response JSON, local types (no fhir4 equivalent): `CdsCard { summary: string; indicator: 'info'; source: { label: string }; detail: string; links: CdsLink[] }`, `CdsLink { label: string; url: string; type: 'absolute' }`, `CrdResponse { cards: CdsCard[] }`. `buildCrdResponse(subgraph): CrdResponse` → one card: `summary` = `Prior authorization: documentation requirements apply (<lcdId> — <title>)` (title clause only when present) — compose then hard-cap at 140 chars (CDS Hooks limit; slice, don't throw); `source.label` = `Medicare LCD <lcdId>` + ` — <title>` when present; `detail` = markdown with a `## Covered codes` section (`<system> <code>` per line) and `## Requirements` numbered list grouped under `### indication|documentation|limitation` headings (skip empty groups); one link to the Questionnaire canonical, label `Complete the documentation questionnaire`. File-header comment: card shape follows CRD v2.2.1's `CRDHooksResponse` logical model; it is not a FHIR resource, hence no meta.profile.
- `src/fhir/plandefinition.ts` — `buildPlanDefinition(subgraph): fhir4.PlanDefinition`. `resourceType`, `id: lcdId`, `url`, `version`/`title` as in dtr, `name: lcdId`, `status: 'active'`, `library: [<same Library stub canonical>]`, `action`: one per covered code, in subgraph order — `{ title: 'Documentation required for <system> <code>', code: [{ coding: [{ system: codeSystemUri(c.system), code: c.code }] }], definitionCanonical: <Questionnaire canonical> }`. No meta.profile (comment: verified — CRD/DTR v2.2 define no PlanDefinition profile; base R4).
- `src/fhir/project.ts` — `projectLcd(subgraph): { crd: CrdResponse; dtr: fhir4.Questionnaire; planDefinition: fhir4.PlanDefinition }` — assembles the three pure builders. Nothing else (no I/O; cli owns files).
- `cli.ts` — verb `project <lcdId>`: `createGraph(loadGraphConfig())` → `readApprovedSubgraph` (draft/missing already throw with actionable messages → existing catch exits 1) → `projectLcd` → `mkdir out` → write `out/<lcdId>.crd.json`, `out/<lcdId>.dtr.json`, `out/<lcdId>.plandefinition.json` (2-space JSON + trailing newline, matching existing snapshot writes) → print the three paths to stdout, close graph in finally. Update USAGE.

## Task 1 — profiles + DTR questionnaire

Files: `src/fhir/profiles.ts`, `src/fhir/dtr.ts`, `src/fhir/test-support.ts`, `src/fhir/dtr.test.ts`. Dev dep: `npm i -D @types/fhir`.

`test-support.ts` (named so the `*.test.ts` glob skips it) exports `syntheticSubgraph(overrides?: Partial<ApprovedSubgraph>): ApprovedSubgraph` — LCD `TEST-P-LCD1` (title `Test policy`, version `3`, status `'approved'`, sourceHash `'hash-lcd'`), 4 requirements (`TEST-P-LCD1-R1..R4`, ordinals 1–4, categories: indication, documentation, documentation, limitation), coveredCodes `[{HCPCS E9819},{HCPCS K9813}]`, article `TEST-P-ART1` with listedCodes `[{ICD-10-CM E99.1}]`, denialReasons `[{id 'TEST-P-ART1-D1', text 'Not medically necessary.'}]`.

TDD; tests to write first (plain asserts on the built object):
- profiles: `codeSystemUri('HCPCS')` and `('ICD-10-CM')` return the exact verified URIs (assert full strings); unknown system throws naming `'SNOMED'` and listing known systems; `instanceCanonical('Questionnaire','X')` = `http://example.org/pa-fhir-poc/Questionnaire/X`.
- dtr: resourceType; `meta.profile` deep-equals `[DTR_STD_QUESTIONNAIRE_PROFILE]`; `status 'active'`; url/version/title/name; cqf-library extension present with the stub canonical; items = exactly the 2 documentation requirements in ordinal order with `linkId`/`text`/`type 'boolean'`; a subgraph override with zero documentation requirements yields no `item` entries (empty or absent — pick one and assert it); `version`/`title` absent from output when absent on the LCD (no `undefined` keys — `JSON.stringify` round-trip must not contain the key).

Steps: failing tests → run (`node --test src/fhir/dtr.test.ts` fails: module not found) → implement → `node --test src/fhir/*.test.ts` + `npx tsc --noEmit` green → commit `M4 task 1: FHIR profiles module + DTR questionnaire builder`.

## Task 2 — CRD card + PlanDefinition

Files: `src/fhir/crd.ts`, `src/fhir/crd.test.ts`, `src/fhir/plandefinition.ts`, `src/fhir/plandefinition.test.ts`. Consumes Task 1's `profiles.ts` + `test-support.ts`.

TDD; tests first:
- crd: exactly one card; `summary.length <= 140` always — including with a 300-char title override; summary contains the lcdId; `indicator 'info'`; `source.label` contains lcdId and title; detail contains every covered `<system> <code>` pair and every requirement text, and the `### documentation` heading; detail for a subgraph with only-indication requirements omits `### limitation`; one link, `type 'absolute'`, url = Questionnaire canonical.
- plandefinition: resourceType; **no `meta` key at all** (JSON round-trip); `status 'active'`; `library` deep-equals `[<stub canonical>]`; `action.length` = coveredCodes length; each action's `code` is a one-element `CodeableConcept[]` whose single `coding` is one element with the **URI** system (assert exact `http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets`) and the code; every `definitionCanonical` = Questionnaire canonical; a covered code with an unknown system (`{system:'CPT'}` override) throws from `codeSystemUri`.

Steps: failing tests → implement → `node --test src/fhir/*.test.ts` + typecheck green → commit `M4 task 2: CRD card and PlanDefinition builders`.

## Task 3 — projectLcd + cli verb

Files: `src/fhir/project.ts`, `cli.ts`, `test/cli-project.test.ts`. Consumes Tasks 1–2.

`project.ts` is 3 calls + a return; its coverage rides on the cli test (no separate unit file).

`test/cli-project.test.ts` — integration, mirror `test/cli-load.test.ts` mechanics exactly (temp cwd, env passthrough incl. NEO4J_*, spawn `node <repo>/cli.ts` with array args). Namespace `TEST-P-`; before(): wipe `TEST-P-*` nodes, `ensureConstraints`, `loadSubgraph` with a fixture equivalent to `syntheticSubgraph()` (test/ may import `src/fhir/test-support.ts`), then `SET status='approved'` via a direct cypher on `TEST-P-LCD1`; after(): wipe + close.
- `project TEST-P-LCD1` exits 0; `out/TEST-P-LCD1.{crd,dtr,plandefinition}.json` all exist under the temp cwd and `JSON.parse`; dtr file has `resourceType 'Questionnaire'` + the profile canonical; plandefinition file has 2 actions; crd file has 1 card.
- Second LCD `TEST-P-LCD2` loaded but left `draft`: `project TEST-P-LCD2` exits 1, stderr mentions `draft`.
- `project TEST-P-NOPE` exits 1, stderr names the id and the load hint.
- `project` with no arg exits 1 with usage.

Steps: failing tests → implement (`project.ts`, cli verb + USAGE line) → `node --test test/cli-project.test.ts`, then full `npm test` (~40s live-LLM gate included — expected) + typecheck green → commit `M4 task 3: project verb emits CRD/DTR/PlanDefinition artifacts`.

## Acceptance (controller runs, real stack — not the implementer)

`node cli.ts project L33822` against the live graph (approved L33822 already loaded): three files in `out/`, dtr item count = documentation-requirement count in the graph, plandefinition action count = 20, spot-check codes/canonicals. This is the real-document verification gate before M4 is called done.
