# M6 (Da Vinci IG conformance, evidence-first) + polish-for-showing — design

Date: 2026-08-21. Approved in-session; M6 shape and polish scope chosen explicitly
by Pat, section 1 (M6) design approved verbatim, remainder delegated ("keep going").

## Goal

Close the labeled M6 stretch goal honestly — the emitted artifacts validated by
the official HL7 validator against the real Da Vinci StructureDefinitions — and
polish the repo for its intended audience (Da Vinci Project members reading a
public reference repo), **without adding any dependency to `npm test` or the
fresh-clone happy path**.

## M6 — evidence-first conformance

### Scope per artifact (follows what the specs define, invents nothing)

| Artifact | Validated against | Why |
|---|---|---|
| DTR Questionnaire | `dtr-std-questionnaire` (DTR IG v2.2.0) via `-ig hl7.fhir.us.davinci-dtr#2.2.0` | The one artifact with a real Da Vinci profile; this is the conformance test. |
| PlanDefinition | Base FHIR R4 (4.0.1), same validator | No CRD/DTR profile exists for PlanDefinition (verified M4 finding). The validator's base-R4 pass (invariants, reference checks) still exceeds our structural tests. |
| CRD card | Out of validator scope; stated in the report | Not a FHIR resource instance — CRD v2.2.1 models the CDS Hooks response as a logical model. |

### Runner

- `node cli.ts validate <lcdId>` reads `out/<lcdId>.dtr.json` and
  `out/<lcdId>.plandefinition.json`, fails loudly if absent (project first).
- Spawns the pinned official `validator_cli.jar` inside an `eclipse-temurin`
  JRE container: array args, `shell: false`, no host Java. Mounts:
  gitignored `tools/` (the jar), `out/` (artifacts, read-only), gitignored
  `.fhir/` (IG package cache → offline after first run).
- `tools/fetch-validator.sh` downloads the pinned jar release once (checksum
  printed). Version pinned in one place.
- Always `-tx n/a`: structure and profile constraints are verified; terminology
  membership is not. Stated plainly in README — HCPCS and ICD-10-CM aren't
  freely distributable code systems, so terminology checking would be partial
  at best.
- Exit non-zero if the validator reports any error. Warnings/informations are
  printed, not fatal — each remaining one is explained in the evidence doc.

### Evidence, not obligation

- We run the validator here, fix genuine findings in `src/fhir/` (known going
  in: `Questionnaire.subjectType` is 1..1 in `dtr-base-questionnaire` and we
  don't emit it; the run may surface more). Fixes stay generic — never
  L33822-shaped.
- Committed evidence: `docs/conformance/L33822.md` — validator output plus a
  human summary of every remaining warning and the CRD-card scope statement.
- `npm test` gains only deterministic-surface tests for the verb (missing
  artifact → loud failure, arg validation). No Docker/network/Java in CI path.

### fhir-zod-gen backlog (documented, not built)

`docs/backlog.md` entry: pa-fhir-poc as first real consumer of fhir-zod-gen —
generated Zod schema as in-process boundary check on projection output, HL7
validator as the oracle that scores it. Blocked on fhir-zod-gen roadmap #1
(IG package resolution). No code in this repo.

## Polish for showing

1. **Committed sample artifacts** — `docs/examples/L33822.{crd,dtr,plandefinition}.json`,
   explicit snapshot copies of a verified run (out/ stays gitignored). A reader
   sees real output without standing up Neo4j + Temporal + Ollama.
2. **Diagrams** — Mermaid in README (GitHub renders natively): the four-stage
   pipeline and the graph model.
3. **README restructure for a cold reader** — payoff before setup: what it is →
   what's proven/deferred → the artifacts themselves → diagrams → setup → run →
   second LCD → graph model → testing.
4. **Hygiene** — LICENSE file (MIT, matching package.json); milestone-status
   wording made consistent across README / CLAUDE.md now that M6 is done.

## Non-goals

Executable CQL, live CDS Hooks service, terminology validation, fhir-zod-gen
integration (backlogged), CI pipeline.
