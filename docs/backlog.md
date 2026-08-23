# Backlog

Deliberately unbuilt work with a designed seam, in rough priority order.

## In-process conformance guardrail via fhir-zod-gen

[fhir-zod-gen](https://github.com/pjerus/fhir-zod-gen) (a sibling project of
this repo's author) generates Zod schemas
(runtime validator + inferred TS type in one declaration) from FHIR IGs. This
repo is its natural first real consumer:

- **The seam:** `projectLcd()` returns typed resources; a generated
  `DtrStdQuestionnaireSchema.safeParse()` at that boundary would catch
  profile-structural drift in-process, on every projection, with zero
  Docker/Java — complementing, not replacing, `cli.ts validate`.
- **The oracle:** the official HL7 validator (M6, `docs/conformance/`) scores
  the generated schema's verdicts. Where the Zod layer passes something the
  validator rejects, that's a finding *for fhir-zod-gen* (its v0.1 skips
  FHIRPath invariants, slicing, and terminology-backed bindings by design).
- **Update 2026-08-22:** IG package resolution has landed in fhir-zod-gen —
  `fhir-zod-gen hl7.fhir.us.davinci-dtr#2.2.0 --skip-terminology` now
  generates a `DTRStdQuestionnaireSchema` end-to-end. Running it against
  this repo's own validator-PASS artifacts (`out/L33822.dtr.json`,
  `out/L33718.dtr.json`) surfaced two false-rejection bugs in the generator
  itself — filed upstream as
  [fhir-zod-gen#23](https://github.com/pjerus/fhir-zod-gen/issues/23)
  (`extension` resolves as scalar instead of `0..*` array) and
  [fhir-zod-gen#24](https://github.com/pjerus/fhir-zod-gen/issues/24)
  (a primitive element carrying an extension slice, e.g. `item.text`, emits
  as `z.object()` instead of its real primitive type). Both were already
  independently found and root-caused by the same author's IG-examples
  validation sweep the day before; this just adds a second, independent
  confirmation from a different IG.
- **Blocked on:** ~~the two issues above landing upstream.~~ **Unblocked
  2026-08-22** — both closed upstream. Redo the generation and re-run
  `safeParse()` against the real projected artifacts before wiring the
  guardrail into `projectLcd()`. Note the guardrail now covers three
  fixtures, and a zero-documentation policy (CIGNA-0158) projects *no*
  Questionnaire at all — the guardrail wires in at `projectLcd()` for
  whichever artifacts exist.

## DTR Questionnaire sourcing beyond the documentation category

After the second-LCD hardening pass, the `documentation` category contains
exactly what the documents' DOCUMENTATION REQUIREMENTS sections state — which
is the DME MACs' *shared* Standard Documentation boilerplate. Both demo LCDs
therefore project near-identical 5-item questionnaires, while the clinically
interesting attestations (AHI thresholds, adherence windows, diabetes
criteria) live in `indication`-category requirements and surface only on the
CRD card. A richer DTR Questionnaire would draw items from indication
criteria too. That is a deliberate M4 design change (the plan says
"documentation-category requirements"), so it is recorded here rather than
made silently.

**Sharpened by the third fixture (2026-08-22):** CIGNA-0158 has *zero*
documentation-category requirements, so it projects no Questionnaire at all
(`dtr-std-questionnaire` requires `item` 1..* — see
`docs/conformance/CIGNA-0158.md`). Indication-sourced items are the only way
a commercial policy of this shape gets a DTR artifact; design decision D4 in
the dialect-seam spec deliberately deferred this to its own task.

## Carried over from the POC plan (out of scope by design)

- Executable CQL — `library` stays a stub canonical.
- Live CDS Hooks service — nothing serves `/cds-services`.
- Cross-system code translation (concept layer + ConceptMap/$translate) —
  every projected CodeableConcept deliberately carries a one-element `coding`
  array so translations are purely additive later.
