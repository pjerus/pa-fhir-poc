# Checkpoint — 2026-08-22 (evening) — payer dialect seam + CIGNA-0158

Branch: `payer-dialect-seam` — merged to `main` (712cb73) and pushed 2026-08-22.
Final `npm test`: 235/235, 0 skipped, including all three live acceptance gates.
Spec: `docs/superpowers/specs/2026-08-22-payer-dialect-seam-design.md`
Plan: `docs/superpowers/plans/2026-08-22-payer-dialect-seam.md`
Design companion artifact: https://claude.ai/code/artifact/b151d363-9b6b-4a7d-92e8-2bbdd2ef944c

## Completed this session

- **Payer dialect seam (Tasks 1–9, subagent-driven, per-task + final review):**
  one pipeline, per-publisher format knowledge in `src/extract/dialects/`
  (`mac`, `cigna`), page-1 banner sniffing + filename/id cross-check,
  vocabulary-parameterized `sections.ts` (boundary-only headings, dot-leader
  TOC rejection), deterministic stance-stratified Cigna coding parser
  (whole-line region anchoring; dual-stance colon-grouping), graph
  `APPLIES_TO` + policy-anchored `DEFINES` with unconditional stale cleanup,
  hoisted `denialReasons` read shape (numeric ordering), review-console
  optional-article upload with dialect arity, CLI arity, fetch-gated fixture
  plumbing, CPT canonical URI. Deterministic test-PDF generator with
  banner'd fixtures (`test/support/make-pdf.ts`).
- **CIGNA-0158 third fixture, live-verified full chain:** fetch → sniff →
  extract (34 requirements: 24 indication / 10 limitation / 0 documentation;
  22 covered codes 13 CPT + 9 HCPCS; 4 stance denial reasons, incl. the
  dual-stance snoring statement spanning the main table) → ground truth
  pinned after line-by-line review against the source PDF → acceptance gate
  passed twice, extraction byte-identical across three live runs → load
  (clean validation) → review workflow approve (`fable-5`) → project →
  validator: PlanDefinition PASS, CRD skip by design, DTR skip (see below).
  Review-console smoke: single-file upload → hoisted stance/appliesTo review
  payload → approve → project, all via the live server.
- **Generic defects the third document exposed, all fixed with regression
  tests:** (1) page-1 TOC dot-leader lines anchored the coding region
  (`fe1c77d`); (2) **the recurring "Ollama flake" was a real bug** —
  `stream:false` meant response headers arrived only on completion, so any
  generation crossing undici's 300s headersTimeout died as "fetch failed";
  `llm-client.ts` now streams NDJSON (`f0c91a2`). Also survived live: a
  wedged Ollama (zombie generation queue) needed a model unload + app
  restart.
- **Design finding (validator-forced):** `dtr-std-questionnaire` requires
  `item` 1..*, so a zero-documentation policy projects **no Questionnaire**
  (`38eb02e`): CRD + PlanDefinition only, card says "coverage criteria
  apply" with no questionnaire link, stale `out/<id>.dtr.json` removed,
  validate reports an explained SKIP. CRD card source label is now
  payer-neutral ("Coverage policy …"). Evidence:
  `docs/conformance/CIGNA-0158.md`.
- Backlog: fhir-zod-gen #23/#24 closed upstream — the Zod guardrail entry is
  unblocked; the indication-sourced-DTR entry is sharpened by CIGNA-0158.

## Verification state

- Deterministic sweep 232/232 + the new fhir/cli suites (103/103 at the
  projection change). Final full `npm test`: **235/235, 0 skipped** —
  including all three live acceptance gates under the streaming client.
- Both MAC fixtures re-verified post-change: L33822 double-PASS via the
  validator; MAC acceptance gates re-run under the streaming client as part
  of the final `npm test`.

## Workers/processes

- None left running (UI server + Temporal worker started fresh for the smoke
  and stopped after). Ollama healthy after restart.

## Next steps

1. Merge decision for `payer-dialect-seam` (user).
2. Zod conformance guardrail (unblocked; own bounded task; three fixtures).
3. Indication-sourced DTR Questionnaire items (design decision D4 deferral —
   now the only route to a DTR artifact for commercial policies).
4. Optional demo polish: Caddy `pa-fhir.test` hostname; UI retry-hint UX.
