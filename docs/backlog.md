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
- **Blocked on:** fhir-zod-gen roadmap #1 — IG package resolution. Until it
  can consume `hl7.fhir.us.davinci-dtr#2.2.0` directly (or a FHIR Schema
  conversion of it exists), there is no input to generate from.

## Carried over from the POC plan (out of scope by design)

- Executable CQL — `library` stays a stub canonical.
- Live CDS Hooks service — nothing serves `/cds-services`.
- Cross-system code translation (concept layer + ConceptMap/$translate) —
  every projected CodeableConcept deliberately carries a one-element `coding`
  array so translations are purely additive later.
