# Plan — M1 hardening + M2 part 2 (article extractor)

Spec: PA-AI-POC-PLAN.md M1/M2 + CLAUDE.md. Motivated by the first real MCD PDFs: the splitter double-attributes text (one exact-duplicate requirement extracted), and nothing extracts the article's codes yet.

## Global Constraints

Same as prior plans: TS strict/ESM/type-stripping (.ts imports, erasableSyntaxOnly), no `any`, NO document-specific data in `src/` (no L33822/A52464/E0607/HCPCS literals — tests use synthetic text reproducing the *pathologies*, never MCD prose), fail loud, `node --test` colocated with --test-concurrency=1, commit per step, no Co-Authored-By trailer. `npm test` + `npx tsc --noEmit` clean at end (1 skip expected — M1 gate, until expected.json exists).

## Task 1 — generic splitter/pdf-text hardening

Files: `src/extract/pdf-text.ts` + test, `src/extract/sections.ts` + test.

Three generic pathologies observed on real Medicare Coverage Database exports (fix each with a test that synthesizes the pathology):

1. **Layered-text repetition (pdf-text.ts):** some PDF lines carry the same string consecutively repeated, e.g. `Coding GuidelinesCoding GuidelinesCoding GuidelinesCoding Guidelines`. After extraction, collapse any line that is exactly one substring repeated 2+ times down to a single instance. Apply per line; must not touch legitimate text.
2. **Recurring table labels are not headings (sections.ts):** revision-history tables repeat single-word ALL-CAPS labels (`INDICATION`, `LIMITATION`) a dozen+ times, and each occurrence currently re-assigns the active section. Rule: pre-count verbatim heading-candidate lines across the document; a candidate whose exact text occurs more than 3 times is a recurring label, not a heading — never assigns a section.
3. **Stop at revision history (sections.ts):** a heading-like line matching /revision history/i ends all section assignment for the rest of the document (set current to none, and make it a rule that no later heading candidate can resume assignment — revision history is always terminal in these documents). Everything after it is change-log boilerplate, not policy text.

Existing tests must stay green (the two-page-policy PDF fixture and all four current sections.test.ts cases). splitSections' public shape is unchanged.

## Task 2 — article extractor + cli wiring

Files: `src/extract/article.ts` + test, `cli.ts` (new verb `extract-article <article.pdf>`, extend `load`/`review-start` snapshot mapping), `test/cli-article.test.ts`.

The paired policy article (e.g. A52464 for L33822) supplies three things. The snapshot file `fixtures/<articleId>.article.json` gets this exact shape (a superset of the ArticleInput the graph loader already reads — cli.ts's readArticleSnapshot validation still passes):

```json
{ "id": "<from filename>", "sourceHash": "<sha256 of extracted text>",
  "listedCodes":   [{ "system": "ICD-10-CM", "code": "..." }],
  "denialReasons": [{ "id": "<articleId>-D1", "text": "..." }],
  "hcpcsCodes":    [{ "system": "HCPCS", "code": "..." }] }
```

- **ICD-10 codes — deterministic, no LLM.** Locate the region between a heading matching /ICD-?10.{0,4}CM CODES? THAT SUPPORT MEDICAL NECESSITY/i and the next heading matching /ICD-?10/i or /revision history/i (whichever comes first — and the Task-1 revision-history cutoff already bounds the tail). Within it, collect tokens matching the ICD-10-CM shape `/^[A-TV-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?$/` (dedup, preserve order). Zero codes found → throw naming the heading it looked for (fail loud — a support-medical-necessity article without codes means the parse failed).
- **HCPCS codes — deterministic.** Region: from a heading matching /HCPCS CODES?/i up to the next non-HCPCS heading; collect tokens matching `/^[A-Z][0-9]{4}$/` (dedup, order). Zero found → throw.
- **Denial reasons — the LLM stage** (this is extraction, the one non-deterministic stage; reuse llm-client + the retry-once/fail-loud pattern from structure.ts). Input: the section whose heading matches /NON-?MEDICAL NECESSITY/i (fallback: whole pre-revision-history text with a warning). Schema: `{ denialReasons: [{ text }] }` — one entry per distinct "will be denied as..." rule; ids assigned deterministically as `<articleId>-D<n>` in returned order (the model never assigns ids — same reasoning as requirement ids).
- `extractArticle(pdfPath, llm)` → the snapshot shape; `cli.ts extract-article <pdf>` prints it and writes `fixtures/<id>.article.json` (id from filename, like extract).
- **load/review-start wiring:** when an article snapshot has `hcpcsCodes`, those become the LCD's `coveredCodes` (replacing the hardcoded `[]` — update the TODO comment to say codes flow from the paired article). `readArticleSnapshot`'s returned ArticleInput still carries only its existing fields; parse hcpcsCodes alongside.
- Tests: unit-test the two deterministic parsers on synthetic article text (fake headings + fake codes, both happy and zero-code throw paths); fake-LLM test for denial reasons incl. deterministic ids; cli test with a synthetic tiny article PDF is NOT required (PDF generation overkill) — instead test extractArticle against synthetic text via an exported `parseArticleText(text, articleId)` seam, with `extractArticle` = pdf-text + that seam; cli test covers only the missing-file failure path (mirror cli-extract.test.ts's pattern).
