# CIGNA-0158 conformance evidence

Validator: official HL7 `validator_cli.jar` 6.10.2 in an `eclipse-temurin:21-jre`
container (`node cli.ts validate CIGNA-0158`), flags `-tx n/a` and
`-allow-example-urls` as documented in `docs/conformance/L33822.md`.
Verified 2026-08-22.

## Results

| Artifact | Check | Result |
|---|---|---|
| `CIGNA-0158.plandefinition.json` | base FHIR R4 | **PASS** — 0 errors; 22 code-lookup warnings (13 CPT + 9 HCPCS), inherent to `-tx n/a`, same class as L33822's HCPCS warnings |
| `CIGNA-0158.crd.json` | — | **SKIP by design** — CDS Hooks logical model under CRD v2.2.1, not a FHIR resource instance |
| `CIGNA-0158.dtr.json` | `dtr-std-questionnaire` (davinci-dtr#2.2.0) | **SKIP — not projected** (see finding below) |

## Finding: a zero-documentation policy cannot carry a conformant DTR Questionnaire

Cigna Medical Coverage Policy 0158 states **no documentation requirements** —
its criteria are all indications and limitations; there is no
DOCUMENTATION REQUIREMENTS section in the document (unlike the MAC template).
The initial projection therefore produced a Questionnaire with zero items,
and the validator rejected it:

```
Error @ Questionnaire: Questionnaire.item: minimum required = 1, but only found 0
  (from http://hl7.org/fhir/us/davinci-dtr/StructureDefinition/dtr-std-questionnaire|2.2.0)
```

`dtr-std-questionnaire` requires `item` 1..*, so an empty Questionnaire is
structurally non-conformant — and a questionnaire with nothing to ask serves
no DTR purpose. The projection now emits **no Questionnaire** for a policy
with zero documentation-category requirements: fabricating an item would
violate the repo's never-invent rule, and shipping a knowingly failing
artifact would violate the conformance bar. The CRD card correspondingly
claims "coverage criteria apply" (not "documentation requirements apply")
and carries no questionnaire link. `node cli.ts validate` reports the
absent artifact as an explained SKIP.

Backlog: sourcing DTR items from *indication* criteria (each attestable
criterion becomes an item) would give commercial policies like this one a
meaningful Questionnaire — and would improve the MAC fixtures too, whose
documentation sections are shared boilerplate. Deliberately out of scope
for the dialect-seam milestone (design decision D4).
