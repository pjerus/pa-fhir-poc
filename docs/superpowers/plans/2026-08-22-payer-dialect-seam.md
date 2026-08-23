# Payer Dialect Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One pipeline with per-publisher dialect profiles, proven by a third fixture — Cigna Medical Coverage Policy 0158 (`CIGNA-0158`) — flowing extract → graph → review → FHIR beside the two Medicare MAC pairs.

**Architecture:** The two extraction stages that read document structure (`sections.ts` and code-table parsing) become parameterized by a `Dialect` profile sniffed from the PDF's page-1 banner. The graph gains an optional-article seam: single-document payers hang `DEFINES` off the policy node, and stance statements carry their stated code lists via a new `APPLIES_TO` relationship. Everything downstream (review workflow, FHIR projection) is untouched except the read shape, which hoists `denialReasons` out of the `article?` nest.

**Tech Stack:** TypeScript (strict, ESM, Node ≥ 22.18 type stripping — no build step), `node --test`, unpdf, Neo4j (live container for graph tests, `TEST-*` namespaced values), Ollama local LLM (only in the M1 acceptance gate and live verification).

**Spec:** `docs/superpowers/specs/2026-08-22-payer-dialect-seam-design.md` — read it first. The arrows.app model is `docs/superpowers/specs/2026-08-22-payer-dialect-graph-model.arrows.json`.

## Global Constraints

- **No document-specific data in `src/`** — no `L33822`, `0158`, `CIGNA-0158`, real requirement wording, or real code values in any `src/` file. Publisher *format* knowledge (banner regexes, heading vocabularies, stance-statement grammar) is allowed — that is what a dialect is. Test files use synthetic ids (`CIGNA-0101`, `TEST-W-…`).
- **Extraction is quarantined**: only `extractLcd`/`extractArticle` call the LLM. Graph and FHIR stages stay pure functions of their inputs. Never add LLM, Docker, Java, or network calls to `npm test` beyond the existing live-Ollama M1 gate.
- **Fail loud, never stub**: unknown dialect, ambiguous sniff, id mismatch, wrong document-set arity, and missing headings in a *required* region all throw with actionable messages.
- **Do not loosen the M1 assertion** (`test/support/expected.ts` + `test/acceptance.test.ts` semantics) to make anything pass.
- TypeScript strict; no `any` in domain types; child processes use array args with `shell: false`.
- `node cli.ts <verb>` commands in README.md must stay in lockstep with `cli.ts`'s `USAGE` string.
- Run `npx tsc --noEmit` before every commit; it must be clean.
- Commit messages: plain, no attribution trailers when a dispatched subagent commits. (If the plan is executed inline by the supervising session, that session appends its own trailer.)
- Graph tests run against the live Neo4j container (`docker compose up -d`) and must namespace every id/code value they create (`TEST-W-`, `TEST-V-`, `TEST-R-` prefixes as the existing tests do) and delete them in `before`/`after`.

---

### Task 1: Deterministic test-PDF generator + banner'd fixtures

The sniffer (Task 5) makes a page-1 banner mandatory, but `test/fixtures/two-page-policy.pdf` has none — every extract test would break. Make fixtures regenerable: a minimal hand-rolled PDF writer (no new dependencies) plus a one-shot generator script, then regenerate the MAC fixture with a banner and add a synthetic Cigna-shaped fixture.

**Files:**
- Create: `test/support/make-pdf.ts`
- Create: `test/support/generate-fixtures.ts`
- Modify: `test/fixtures/two-page-policy.pdf` (regenerated binary)
- Create: `test/fixtures/CIGNA-0101.pdf` (generated binary)
- Test: `test/support/make-pdf.test.ts`
- Possibly modify: `src/extract/pdf-text.test.ts`, `src/extract/extract.test.ts`, `test/cli-extract.test.ts` (only if their assertions mention the old fixture's exact text/page count)

**Interfaces:**
- Consumes: `extractPdfText(path)` from `src/extract/pdf-text.ts` (round-trip check).
- Produces: `makePdf(pages: ReadonlyArray<readonly string[]>): Uint8Array` — one entry per page, one string per text line. Fixture PDFs whose page-1 text carries the dialect banners defined in Tasks 3/5.

- [ ] **Step 1: Write the failing round-trip test**

```ts
// test/support/make-pdf.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makePdf } from './make-pdf.ts';
import { extractPdfText } from '../../src/extract/pdf-text.ts';

test('makePdf output round-trips through extractPdfText', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'make-pdf-'));
  const path = join(dir, 'sample.pdf');
  await writeFile(path, makePdf([
    ['Local Coverage Determination (LCD)', 'First page line.'],
    ['Second page line.'],
  ]));

  const { pages, totalPages } = await extractPdfText(path);
  assert.equal(totalPages, 2);
  assert.match(pages[0] ?? '', /Local Coverage Determination \(LCD\)/);
  assert.match(pages[0] ?? '', /First page line\./);
  assert.match(pages[1] ?? '', /Second page line\./);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/support/make-pdf.test.ts`
Expected: FAIL — cannot find module `make-pdf.ts`.

- [ ] **Step 3: Implement the PDF writer**

```ts
// test/support/make-pdf.ts
/**
 * Minimal deterministic PDF writer for test fixtures — Helvetica text lines,
 * one content stream per page, byte-accurate xref. No dependencies, so
 * fixtures are regenerable without adding a PDF-authoring library.
 */
export function makePdf(pages: ReadonlyArray<readonly string[]>): Uint8Array {
  const escape = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const objects: string[] = [];
  const pageObjNumber = (pageIndex: number): number => 4 + pageIndex * 2;
  const kids = pages.map((_, i) => `${pageObjNumber(i)} 0 R`).join(' ');

  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`;
  objects[3] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

  pages.forEach((lines, i) => {
    const pageNum = pageObjNumber(i);
    const contentNum = pageNum + 1;
    const ops = lines
      .map((line, j) =>
        j === 0 ? `BT /F1 12 Tf 72 720 Td (${escape(line)}) Tj` : `0 -16 Td (${escape(line)}) Tj`,
      )
      .join('\n');
    const stream = `${ops}\nET`;
    objects[pageNum] =
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`;
    objects[contentNum] =
      `${contentNum} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\n` +
      `stream\n${stream}\nendstream\nendobj\n`;
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(body, 'utf8');
    body += objects[n];
  }
  const xrefStart = Buffer.byteLength(body, 'utf8');
  const count = objects.length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body + xref + trailer, 'utf8'));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/support/make-pdf.test.ts`
Expected: PASS. If pdfjs (unpdf) rejects the file, the xref offsets are the first suspect — they must be byte offsets of each `N 0 obj` line from file start.

- [ ] **Step 5: Write the fixture generator**

```ts
// test/support/generate-fixtures.ts
/**
 * One-shot generator for the committed test-fixture PDFs. Run manually after
 * changing fixture content:  node test/support/generate-fixtures.ts
 * The PDFs are committed; this script is NOT part of npm test.
 */
import { writeFile } from 'node:fs/promises';

import { makePdf } from './make-pdf.ts';

// MAC-shaped: page-1 banner is the dialect sniff target; the bare
// "two-page-policy" token is what the MAC id cross-check finds.
const MAC_PAGES: ReadonlyArray<readonly string[]> = [
  [
    'Local Coverage Determination (LCD)',
    'Sample Policy',
    'two-page-policy',
    'Indications',
    'The patient must have a documented diagnosis.',
  ],
  ['Documentation Requirements', 'The treating order must be retained.'],
];

// Cigna-shaped: banner + policy-number field on page 1; Coverage Policy
// criteria, stance-stratified Coding Information, and noise sections that
// must be bounded out. Ids and codes are synthetic (CIGNA-0101, 12345…).
const CIGNA_PAGES: ReadonlyArray<readonly string[]> = [
  [
    'Medical Coverage Policy',
    'Effective Date 1/1/2026',
    'Coverage Policy Number 0101',
    'Table of Contents',
    'Overview ................................ 2',
    'Coverage Policy ......................... 2',
    'INSTRUCTIONS FOR USE',
    'Coverage determinations require consideration of the applicable plan document.',
  ],
  [
    'Overview',
    'This Coverage Policy addresses widget therapy.',
    'Coverage Policy',
    'Widget therapy is considered medically necessary when ALL of the following are met:',
    'documented diagnosis of testitis',
    'documentation that demonstrates conservative therapy failure',
    'Widget removal as a stand-alone procedure is considered not medically necessary.',
  ],
  [
    'Coding Information',
    'Notes:',
    'Considered Medically Necessary when criteria in the applicable policy statements listed above are met:',
    'CPT Codes Description',
    '12345 Widget implantation',
    'A1234 Widget device',
    'Considered Not Medically Necessary when used to report widget removal as a stand-alone procedure:',
    '23456 Widget removal',
    'Considered Experimental/Investigational/Unproven for the treatment of testitis:',
    '34567 Widget ablation',
    'General Background',
    'Literature review noise that must not bleed into requirements.',
    'References',
    'Revision Details',
    'Annual review 1/1/2026',
  ],
];

await writeFile('test/fixtures/two-page-policy.pdf', makePdf(MAC_PAGES));
await writeFile('test/fixtures/CIGNA-0101.pdf', makePdf(CIGNA_PAGES));
process.stderr.write('regenerated test/fixtures/two-page-policy.pdf and test/fixtures/CIGNA-0101.pdf\n');
```

- [ ] **Step 6: Regenerate fixtures and fix any fixture-text-dependent tests**

Run: `node test/support/generate-fixtures.ts`
Then: `node --test src/extract/pdf-text.test.ts src/extract/extract.test.ts test/cli-extract.test.ts`
The regenerated MAC fixture keeps the same section headings and body sentences, adding only the three banner lines, so assertions on requirements/sections should hold. If a test asserts exact page text or a line count, update its expectation to include the banner lines — do not change what the test is *about*.

- [ ] **Step 7: Full check and commit**

Run: `npx tsc --noEmit && npm test`
Expected: clean typecheck; all tests pass (the live M1 gate needs Ollama running, as today).

```bash
git add test/support/make-pdf.ts test/support/make-pdf.test.ts test/support/generate-fixtures.ts test/fixtures/two-page-policy.pdf test/fixtures/CIGNA-0101.pdf src/extract/pdf-text.test.ts src/extract/extract.test.ts test/cli-extract.test.ts
git commit -m "test: deterministic PDF generator; banner'd MAC fixture + synthetic Cigna fixture"
```

---

### Task 2: Section vocabulary seam in `sections.ts` + MAC vocabulary

`splitSections` currently hardcodes the MAC heading vocabulary. Parameterize it with a `SectionVocabulary`, add two mechanism upgrades the Cigna format needs (boundary-only headings; dot-leader TOC-line rejection), and move the MAC vocabulary into the first dialect file.

**Files:**
- Modify: `src/extract/sections.ts` (full rewrite below)
- Create: `src/extract/dialects/mac.ts` (vocabulary part only; the full Dialect object comes in Task 5)
- Modify: `src/extract/sections.test.ts` (pass `MAC_VOCABULARY`; add new-mechanism tests)
- Modify: `src/extract/extract.ts` (call sites), `src/extract/article.ts` (terminal-cut call sites)

**Interfaces:**
- Produces (from `sections.ts`):
  - `type SectionName = 'indications' | 'documentation' | 'limitations'` (unchanged)
  - `interface SectionHeadingSpec { readonly sections: readonly SectionName[]; readonly pattern: RegExp }`
  - `interface SectionVocabulary { readonly headings: readonly SectionHeadingSpec[]; readonly boundaries: readonly RegExp[]; readonly terminal: RegExp }`
  - `splitSections(text: string, vocabulary: SectionVocabulary): SplitResult` (same `SplitResult` as today)
  - `cutAtTerminal(text: string, terminal: RegExp): string` (replaces `cutAtRevisionHistory`; the old name is deleted, callers updated)
- Produces (from `dialects/mac.ts`): `MAC_VOCABULARY: SectionVocabulary`
- Consumed by: Task 3 (Cigna vocabulary), Task 5 (Dialect objects), `article.ts` (terminal cut).

- [ ] **Step 1: Write the failing tests for the new mechanism**

Add to `src/extract/sections.test.ts` (adapt imports to the file's existing style):

```ts
import { MAC_VOCABULARY } from './dialects/mac.ts';

test('splitSections takes a vocabulary: MAC vocabulary reproduces current behavior', () => {
  const text = ['Coverage Indications', 'Body A.', 'Documentation Requirements', 'Body B.'].join('\n');
  const { sections } = splitSections(text, MAC_VOCABULARY);
  assert.equal(sections.indications, 'Body A.');
  assert.equal(sections.documentation, 'Body B.');
});

test('a boundary heading ends the current section without opening one', () => {
  const vocabulary: SectionVocabulary = {
    headings: [{ sections: ['indications'], pattern: /^Coverage\s+Policy\b/i }],
    boundaries: [/^General\s+Background\b/i],
    terminal: /revision\s+details/i,
  };
  const text = ['Coverage Policy', 'Real criterion.', 'General Background', 'Literature noise.'].join('\n');
  const { sections } = splitSections(text, vocabulary);
  assert.equal(sections.indications, 'Real criterion.');
});

test('a dot-leader table-of-contents line is never a heading', () => {
  const vocabulary: SectionVocabulary = {
    headings: [{ sections: ['indications'], pattern: /^Coverage\s+Policy\b/i }],
    boundaries: [],
    terminal: /revision\s+details/i,
  };
  const text = ['Coverage Policy ......................... 2', 'TOC junk.', 'Coverage Policy', 'Real criterion.'].join('\n');
  const { sections } = splitSections(text, vocabulary);
  assert.equal(sections.indications, 'Real criterion.');
});

test('cutAtTerminal cuts at the supplied terminal heading', () => {
  const text = ['Keep this.', 'Revision Details', 'Change log.'].join('\n');
  assert.equal(cutAtTerminal(text, /revision\s+details/i), 'Keep this.');
});
```

Also update every existing test in the file to pass `MAC_VOCABULARY` as `splitSections`'s second argument, and every `cutAtRevisionHistory(x)` call to `cutAtTerminal(x, MAC_VOCABULARY.terminal)`.

- [ ] **Step 2: Run to verify failures**

Run: `node --test src/extract/sections.test.ts`
Expected: FAIL — `dialects/mac.ts` missing, signatures mismatch.

- [ ] **Step 3: Rewrite `sections.ts` and create `dialects/mac.ts`**

Full new `src/extract/sections.ts`:

```ts
export type SectionName = 'indications' | 'documentation' | 'limitations';

export const SECTION_NAMES: readonly SectionName[] = [
  'indications',
  'documentation',
  'limitations',
];

export type SectionMap = Readonly<Record<SectionName, string | null>>;

export interface SplitResult {
  readonly sections: SectionMap;
  readonly warnings: readonly string[];
}

/** A heading pattern is tested against the head window of a heading-like line. */
export interface SectionHeadingSpec {
  readonly sections: readonly SectionName[];
  readonly pattern: RegExp;
}

/**
 * The per-publisher vocabulary the structural splitter runs with: which
 * headings open which sections, which headings merely END a section
 * (boundaries — recognized but never extracted from), and the terminal
 * heading after which everything is change-log boilerplate.
 */
export interface SectionVocabulary {
  readonly headings: readonly SectionHeadingSpec[];
  readonly boundaries: readonly RegExp[];
  readonly terminal: RegExp;
}

const MAX_HEADING_WORDS = 12;

// PDF exports hard-wrap prose, so a mid-sentence fragment can land on its
// own short line ("of 10 events and documentation of:"). True headings start
// with a capital and name their section within the first few words; fragments
// start lowercase, with a digit, or a quote, or bury the keyword mid-sentence.
const KEYWORD_WORD_WINDOW = 3;

// A dot-leader run marks a table-of-contents line ("Coverage Policy .... 2"),
// which repeats real heading text without being a heading.
const DOT_LEADER = /\.{4,}/;

// Revision-history tables repeat INDICATION/LIMITATION-style labels far more
// often than a real heading recurs in the same document; past this count a
// verbatim-matching heading candidate is treated as a recurring table label.
const MAX_HEADING_RECURRENCE = 3;

/**
 * Publisher formatting varies, so headings are recognised structurally rather
 * than by an exact-title list: a short, non-sentence line that names a section.
 */
function isHeadingLike(line: string): boolean {
  if (line === '' || line.endsWith('.')) return false;
  if (!/^[A-Z]/.test(line)) return false;
  if (DOT_LEADER.test(line)) return false;
  return line.split(/\s+/).length <= MAX_HEADING_WORDS;
}

type HeadingMatch =
  | { readonly kind: 'sections'; readonly names: readonly SectionName[] }
  | { readonly kind: 'boundary' }
  | null;

/** A heading may name several sections ("Indications, Limitations, and/or..."). */
function matchHeading(line: string, vocabulary: SectionVocabulary): HeadingMatch {
  if (!isHeadingLike(line)) return null;
  const head = line.split(/\s+/).slice(0, KEYWORD_WORD_WINDOW).join(' ');
  const names = vocabulary.headings
    .filter(({ pattern }) => pattern.test(head))
    .flatMap(({ sections }) => sections);
  if (names.length > 0) return { kind: 'sections', names: [...new Set(names)] };
  if (vocabulary.boundaries.some((pattern) => pattern.test(head))) return { kind: 'boundary' };
  return null;
}

/**
 * The terminal heading is always last in these documents: everything from it
 * onward is change-log boilerplate, not policy text, and no later heading
 * candidate may resume section assignment. Returns the text up to (excluding)
 * that heading, or the whole input if it never appears.
 */
export function cutAtTerminal(text: string, terminal: RegExp): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (isHeadingLike(line) && terminal.test(line)) {
      return lines.slice(0, i).join('\n');
    }
  }
  return text;
}

export function splitSections(text: string, vocabulary: SectionVocabulary): SplitResult {
  const lines = cutAtTerminal(text, vocabulary.terminal)
    .split('\n')
    .map((rawLine) => rawLine.trim());

  const candidateCounts = new Map<string, number>();
  for (const line of lines) {
    if (matchHeading(line, vocabulary)?.kind === 'sections') {
      candidateCounts.set(line, (candidateCounts.get(line) ?? 0) + 1);
    }
  }

  const bodies = new Map<SectionName, string[]>();
  let current: readonly SectionName[] = [];

  for (const line of lines) {
    const match = matchHeading(line, vocabulary);
    if (match?.kind === 'sections') {
      const isRecurringLabel = (candidateCounts.get(line) ?? 0) > MAX_HEADING_RECURRENCE;
      if (isRecurringLabel) continue;

      current = match.names;
      for (const name of match.names) {
        if (!bodies.has(name)) bodies.set(name, []);
      }
      continue;
    }
    if (match?.kind === 'boundary') {
      current = [];
      continue;
    }

    if (line === '') continue;
    for (const name of current) bodies.get(name)?.push(line);
  }

  const sections: Record<SectionName, string | null> = {
    indications: null,
    documentation: null,
    limitations: null,
  };
  const warnings: string[] = [];

  for (const name of SECTION_NAMES) {
    const body = bodies.get(name);
    if (body === undefined) {
      warnings.push(`No "${name}" heading found; downstream extraction will skip that section.`);
      continue;
    }
    sections[name] = body.join('\n');
  }

  return { sections, warnings };
}
```

New `src/extract/dialects/mac.ts`:

```ts
import type { SectionVocabulary } from '../sections.ts';

/**
 * The CMS MAC template's section vocabulary — the exact patterns that were
 * hardcoded in sections.ts before the dialect seam. MAC documents have no
 * boundary-only headings the splitter needs: text after unrecognized
 * headings simply keeps accumulating, matching pre-seam behavior that both
 * MAC ground truths were reviewed against.
 */
export const MAC_VOCABULARY: SectionVocabulary = {
  headings: [
    { sections: ['indications'], pattern: /\bindications?\b/i },
    { sections: ['documentation'], pattern: /\bdocumentation\b/i },
    { sections: ['limitations'], pattern: /\blimitations?\b/i },
  ],
  boundaries: [],
  terminal: /revision history/i,
};
```

Update call sites:
- `src/extract/extract.ts`: `splitSections(text)` → `splitSections(text, MAC_VOCABULARY)` and `cutAtRevisionHistory(text)` → `cutAtTerminal(text, MAC_VOCABULARY.terminal)` (imports from `./sections.ts` and `./dialects/mac.ts`). This is temporary until Task 6 makes the dialect dynamic.
- `src/extract/article.ts`: `cutAtRevisionHistory(text)` → `cutAtTerminal(text, MAC_VOCABULARY.terminal)` (articles are a MAC-only concept; importing the MAC vocabulary here is correct, and creates no cycle because `mac.ts` imports only `sections.ts`).

- [ ] **Step 4: Run the extract-module tests**

Run: `node --test src/extract/sections.test.ts src/extract/structure.test.ts src/extract/extract.test.ts src/extract/article.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full deterministic sweep, commit**

Run: `npx tsc --noEmit && node --test src/ test/support test/cli-extract.test.ts`

```bash
git add src/extract/sections.ts src/extract/dialects/mac.ts src/extract/sections.test.ts src/extract/extract.ts src/extract/article.ts
git commit -m "extract: parameterize section splitting with a per-dialect vocabulary"
```

---

### Task 3: Cigna section vocabulary

**Files:**
- Create: `src/extract/dialects/cigna.ts` (vocabulary part; full Dialect object in Task 5)
- Test: `src/extract/dialects/cigna.test.ts`

**Interfaces:**
- Consumes: `SectionVocabulary`, `splitSections`, `cutAtTerminal` from Task 2.
- Produces: `CIGNA_VOCABULARY: SectionVocabulary` — "Coverage Policy" opens `indications` + `limitations` (one body, union categories — the same multi-section mechanism MAC's combined heading uses); Overview / INSTRUCTIONS FOR USE / Coding Information / General Background / Health Equity / References are boundaries; "Revision Details" is terminal.

- [ ] **Step 1: Write the failing tests**

```ts
// src/extract/dialects/cigna.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { CIGNA_VOCABULARY } from './cigna.ts';
import { cutAtTerminal, splitSections } from '../sections.ts';

// Condensed from the real document shape; synthetic wording.
const SAMPLE = [
  'Medical Coverage Policy',
  'Coverage Policy Number 0101',
  'Table of Contents',
  'Coverage Policy ......................... 2',
  'INSTRUCTIONS FOR USE',
  'Plan documents supersede this policy.',
  'Overview',
  'This Coverage Policy addresses widget therapy.',
  'Coverage Policy',
  'Widget therapy is considered medically necessary when ALL of the following are met:',
  'documented diagnosis of testitis',
  'Widget removal as a stand-alone procedure is considered not medically necessary.',
  'Coding Information',
  'Considered Medically Necessary when criteria above are met:',
  '12345 Widget implantation',
  'General Background',
  'Literature review noise.',
  'References',
  'Author A. Journal of Widgets.',
  'Revision Details',
  'Annual review.',
].join('\n');

test('Coverage Policy body maps to indications + limitations, and only that body', () => {
  const { sections } = splitSections(cutAtTerminal(SAMPLE, CIGNA_VOCABULARY.terminal), CIGNA_VOCABULARY);
  assert.equal(sections.indications, sections.limitations);
  assert.match(sections.indications ?? '', /considered medically necessary when ALL/);
  assert.match(sections.indications ?? '', /stand-alone procedure is considered not medically necessary/);
});

test('boundary sections never bleed into the criteria body', () => {
  const { sections } = splitSections(cutAtTerminal(SAMPLE, CIGNA_VOCABULARY.terminal), CIGNA_VOCABULARY);
  for (const noise of [/Literature review noise/, /Journal of Widgets/, /Widget implantation/, /Plan documents supersede/, /addresses widget therapy/]) {
    assert.doesNotMatch(sections.indications ?? '', noise);
  }
});

test('the page banner and TOC lines do not open the Coverage Policy section early', () => {
  const { sections } = splitSections(cutAtTerminal(SAMPLE, CIGNA_VOCABULARY.terminal), CIGNA_VOCABULARY);
  assert.doesNotMatch(sections.indications ?? '', /Coverage Policy Number/);
  assert.doesNotMatch(sections.indications ?? '', /Table of Contents/);
});

test('Cigna has no documentation section — the splitter warns, not throws', () => {
  const { sections, warnings } = splitSections(cutAtTerminal(SAMPLE, CIGNA_VOCABULARY.terminal), CIGNA_VOCABULARY);
  assert.equal(sections.documentation, null);
  assert.ok(warnings.some((w) => w.includes('documentation')));
});

test('Revision Details is terminal', () => {
  assert.doesNotMatch(cutAtTerminal(SAMPLE, CIGNA_VOCABULARY.terminal), /Annual review/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/extract/dialects/cigna.test.ts`
Expected: FAIL — `cigna.ts` missing.

- [ ] **Step 3: Implement the vocabulary**

```ts
// src/extract/dialects/cigna.ts
import type { SectionVocabulary } from '../sections.ts';

/**
 * Cigna "Medical Coverage Policy" documents put all criteria (indications
 * AND limitations, interleaved) under one "Coverage Policy" heading, and
 * carry no documentation-requirements section at all — the resulting
 * `documentation: null` is a faithful finding, not a parse failure.
 *
 * Heading patterns are line-start anchored (`^`) against the head window:
 * the running page footer "Medical Coverage Policy: NNNN" and the page-1
 * banner contain the phrase mid-line and must not open the section. The
 * negative lookahead keeps the page-1 "Coverage Policy Number …" field from
 * opening it either (its dot leaders usually reject it first, but layout
 * extraction is not guaranteed to preserve them).
 * Boundary headings are load-bearing here (unlike MAC): General Background
 * is a literature review that would otherwise flood the criteria body.
 */
export const CIGNA_VOCABULARY: SectionVocabulary = {
  headings: [{ sections: ['indications', 'limitations'], pattern: /^Coverage\s+Policy\b(?!\s+Number)/i }],
  boundaries: [
    /^Overview\b/i,
    /^INSTRUCTIONS\s+FOR\s+USE\b/i,
    /^Coding\s+Information\b/i,
    /^General\s+Background\b/i,
    /^Health\s+Equity\b/i,
    /^References\b/i,
  ],
  terminal: /^Revision\s+Details\b/i,
};
```

- [ ] **Step 4: Run to verify pass, commit**

Run: `node --test src/extract/dialects/cigna.test.ts && npx tsc --noEmit`

```bash
git add src/extract/dialects/cigna.ts src/extract/dialects/cigna.test.ts
git commit -m "extract: Cigna section vocabulary"
```

---

### Task 4: Domain types + Cigna coding-information parser

The stance-stratified code tables: each table is headed by the stance statement itself, so parse the Coding Information region into (statement, stance, codes) groups deterministically — no LLM.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/extract/article.ts` (export `tokensMatching`)
- Create: `src/extract/dialects/cigna-coding.ts`
- Test: `src/extract/dialects/cigna-coding.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`):
  - `type DenialStance = 'not-medically-necessary' | 'experimental-investigational'`
  - `DenialReason` gains `readonly stance?: DenialStance`
  - `interface PolicyDenialReason extends DenialReason { readonly appliesTo: readonly CodeRef[] }`
  - `LcdInput` gains `readonly denialReasons?: readonly PolicyDenialReason[]`
- Produces (in `cigna-coding.ts`):
  - `interface DialectCoding { readonly coveredCodes: readonly CodeRef[]; readonly denialReasons: readonly PolicyDenialReason[]; readonly warnings: readonly string[] }`
  - `parseCignaCodingInformation(cutText: string, lcdId: string): DialectCoding` — denial-reason ids are `` `${lcdId}-D${n}` `` in document order.
- Consumed by: Task 5 (Cigna Dialect), Task 7 (graph write), Task 8 (read shape).

- [ ] **Step 1: Add the type changes**

In `src/types.ts`, after `CodeRef`:

```ts
/** How a payer's stance statement refuses coverage. Absent on MAC-sourced denial reasons. */
export type DenialStance = 'not-medically-necessary' | 'experimental-investigational';

export interface DenialReason {
  readonly id: string;
  readonly text: string;
  readonly stance?: DenialStance;
}

/** A denial reason plus the codes its source document explicitly groups under it. */
export interface PolicyDenialReason extends DenialReason {
  readonly appliesTo: readonly CodeRef[];
}
```

And extend `LcdInput` with:

```ts
  /** Present for single-document dialects whose policy states its own denial reasons. */
  readonly denialReasons?: readonly PolicyDenialReason[];
```

In `src/extract/article.ts`, change `function tokensMatching` to `export function tokensMatching` (no other change).

Run: `npx tsc --noEmit` — expected clean (all additions are optional).

- [ ] **Step 2: Write the failing parser tests**

```ts
// src/extract/dialects/cigna-coding.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCignaCodingInformation } from './cigna-coding.ts';

// Shapes taken from the real document (condensed, synthetic wording/codes),
// including the dual-stance main-table heading.
const SAMPLE = [
  'Coding Information',
  'Notes:',
  '1. This list of codes may not be all-inclusive.',
  'Considered Medically Necessary when criteria in the applicable policy statements listed',
  'above are met for the treatment of widget disease. Considered Not Medically Necessary for',
  'the treatment of squeaking in the absence of widget disease:',
  'CPT Codes Description',
  '12345 Widget implantation',
  '12346 Widget reconstruction',
  'HCPCS Codes Description',
  'A1234 Widget device',
  'Considered Not Medically Necessary when used to report widget removal as a stand-alone procedure:',
  '23456 Widget removal',
  'Considered Experimental/Investigational/Unproven for the treatment of widget disease:',
  '34567 Widget ablation',
  'C9876 Widget implant insertion',
  'General Background',
  'Widget therapy 12399 mentioned in prose must not be harvested.',
].join('\n');

test('MN table codes become covered codes with shape-derived systems', () => {
  const { coveredCodes } = parseCignaCodingInformation(SAMPLE, 'CIGNA-0101');
  assert.deepEqual(coveredCodes, [
    { system: 'CPT', code: '12345' },
    { system: 'CPT', code: '12346' },
    { system: 'HCPCS', code: 'A1234' },
  ]);
});

test('each non-MN stance statement becomes a denial reason applying to its table codes', () => {
  const { denialReasons } = parseCignaCodingInformation(SAMPLE, 'CIGNA-0101');
  const standalone = denialReasons.find((d) => d.text.includes('stand-alone'));
  assert.equal(standalone?.stance, 'not-medically-necessary');
  assert.deepEqual(standalone?.appliesTo, [{ system: 'CPT', code: '23456' }]);

  const experimental = denialReasons.find((d) => d.stance === 'experimental-investigational');
  assert.deepEqual(experimental?.appliesTo, [
    { system: 'CPT', code: '34567' },
    { system: 'HCPCS', code: 'C9876' },
  ]);
});

test('a dual-stance heading covers the table AND yields a denial reason spanning it', () => {
  const { coveredCodes, denialReasons } = parseCignaCodingInformation(SAMPLE, 'CIGNA-0101');
  const squeaking = denialReasons.find((d) => d.text.includes('squeaking'));
  assert.equal(squeaking?.stance, 'not-medically-necessary');
  // The snoring-analog statement applies to the same table the MN half covers.
  assert.deepEqual(squeaking?.appliesTo, coveredCodes);
});

test('denial-reason ids are lcd-scoped and ordered', () => {
  const { denialReasons } = parseCignaCodingInformation(SAMPLE, 'CIGNA-0101');
  assert.deepEqual(denialReasons.map((d) => d.id), ['CIGNA-0101-D1', 'CIGNA-0101-D2', 'CIGNA-0101-D3']);
});

test('codes in prose outside the region are never harvested', () => {
  const { coveredCodes, denialReasons } = parseCignaCodingInformation(SAMPLE, 'CIGNA-0101');
  const all = [...coveredCodes, ...denialReasons.flatMap((d) => d.appliesTo)].map((c) => c.code);
  assert.ok(!all.includes('12399'));
});

test('a missing Coding Information heading throws loud', () => {
  assert.throws(() => parseCignaCodingInformation('No coding section here.', 'CIGNA-0101'), /Coding Information/);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test src/extract/dialects/cigna-coding.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement the parser**

```ts
// src/extract/dialects/cigna-coding.ts
import type { CodeRef, DenialStance, PolicyDenialReason } from '../../types.ts';
import { tokensMatching } from '../article.ts';

export interface DialectCoding {
  readonly coveredCodes: readonly CodeRef[];
  readonly denialReasons: readonly PolicyDenialReason[];
  readonly warnings: readonly string[];
}

const CODING_INFORMATION_HEADING = /Coding\s+Information/i;
const REGION_END_HEADING = /General\s+Background/i;

// Stance-statement openers. Order matters: "Not Medically Necessary" must be
// tried before "Medically Necessary" so the longer phrase wins.
const STATEMENT_START =
  /Considered\s+(Not\s+Medically\s+Necessary|Medically\s+Necessary|Experimental\/\s*Investigational\/\s*Unproven)/gi;

// CPT is 4 digits + digit-or-letter (21193, 0466T); HCPCS Level II is a
// letter + 4 digits (E0470, C9876). Shape alone separates the two systems.
const CPT_SHAPE = /^[0-9]{4}[0-9A-Z]$/;
const HCPCS_SHAPE = /^[A-Z][0-9]{4}$/;

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function stanceOf(matchedPhrase: string): 'covered' | DenialStance {
  const phrase = matchedPhrase.toLowerCase();
  if (phrase.includes('not medically necessary')) return 'not-medically-necessary';
  if (phrase.includes('experimental')) return 'experimental-investigational';
  return 'covered';
}

function codesIn(tableText: string): CodeRef[] {
  const cpt = tokensMatching(tableText, CPT_SHAPE).map((code) => ({ system: 'CPT', code }));
  const hcpcs = tokensMatching(tableText, HCPCS_SHAPE).map((code) => ({ system: 'HCPCS', code }));
  return [...cpt, ...hcpcs];
}

interface StanceSentence {
  readonly start: number;
  readonly stance: 'covered' | DenialStance;
}

/**
 * Cigna's Coding Information stratifies its code tables by coverage stance,
 * and each table is headed by the stance statement itself — the code↔statement
 * grouping is stated by the document. A heading may carry more than one
 * stance sentence ending in a single colon (the dual-stance case); every
 * sentence in that group shares the table that follows the colon.
 * Deterministic by design: the statements ARE the denial-reason text, so no
 * LLM is involved.
 */
export function parseCignaCodingInformation(cutText: string, lcdId: string): DialectCoding {
  const headingMatch = CODING_INFORMATION_HEADING.exec(cutText);
  if (headingMatch === null) {
    throw new Error('Could not find a "Coding Information" heading in the policy document.');
  }
  const afterHeading = cutText.slice(headingMatch.index + headingMatch[0].length);
  const endMatch = REGION_END_HEADING.exec(afterHeading);
  const region = endMatch === null ? afterHeading : afterHeading.slice(0, endMatch.index);

  const sentences: StanceSentence[] = [];
  STATEMENT_START.lastIndex = 0;
  for (let m = STATEMENT_START.exec(region); m !== null; m = STATEMENT_START.exec(region)) {
    sentences.push({ start: m.index, stance: stanceOf(m[1] ?? '') });
  }
  if (sentences.length === 0) {
    throw new Error('Found "Coding Information" but no "Considered ..." stance statements beneath it.');
  }

  // Group sentences that share a terminating colon (dual-stance headings).
  interface Group {
    readonly sentences: Array<{ readonly textStart: number; readonly textEnd: number; readonly stance: 'covered' | DenialStance }>;
    readonly colonIndex: number;
  }
  const groups: Group[] = [];
  for (const sentence of sentences) {
    const colonIndex = region.indexOf(':', sentence.start);
    if (colonIndex === -1) {
      throw new Error(
        `A "Considered ..." stance statement has no terminating colon: ` +
          `"${normalizeWhitespace(region.slice(sentence.start, sentence.start + 120))}..."`,
      );
    }
    const group = groups.find((g) => g.colonIndex === colonIndex);
    const entry = { textStart: sentence.start, textEnd: colonIndex + 1, stance: sentence.stance };
    if (group === undefined) groups.push({ sentences: [entry], colonIndex });
    else group.sentences.push(entry);
  }

  const coveredCodes: CodeRef[] = [];
  const denials: Array<{ readonly text: string; readonly stance: DenialStance; readonly appliesTo: readonly CodeRef[] }> = [];
  const warnings: string[] = [];

  groups.forEach((group, groupIndex) => {
    const tableEnd = groups[groupIndex + 1]?.sentences[0]?.textStart ?? region.length;
    const tableText = region.slice(group.colonIndex + 1, tableEnd);
    const codes = codesIn(tableText);
    if (codes.length === 0) {
      warnings.push(
        `Stance statement with no codes beneath it: ` +
          `"${normalizeWhitespace(region.slice(group.sentences[0]?.textStart ?? 0, group.colonIndex + 1)).slice(0, 120)}"`,
      );
    }
    group.sentences.forEach((sentence, sentenceIndex) => {
      const nextInGroup = group.sentences[sentenceIndex + 1]?.textStart ?? sentence.textEnd;
      const text = normalizeWhitespace(region.slice(sentence.textStart, Math.min(nextInGroup, sentence.textEnd)));
      if (sentence.stance === 'covered') {
        coveredCodes.push(...codes);
      } else {
        denials.push({ text, stance: sentence.stance, appliesTo: codes });
      }
    });
  });

  return {
    coveredCodes,
    denialReasons: denials.map((d, index) => ({ id: `${lcdId}-D${index + 1}`, ...d })),
    warnings,
  };
}
```

- [ ] **Step 5: Run to verify pass, typecheck, commit**

Run: `node --test src/extract/dialects/cigna-coding.test.ts && npx tsc --noEmit`

```bash
git add src/types.ts src/extract/article.ts src/extract/dialects/cigna-coding.ts src/extract/dialects/cigna-coding.test.ts
git commit -m "extract: stance-stratified Cigna coding parser; DenialStance/PolicyDenialReason types"
```

---

### Task 5: Dialect interface, sniffer, and id cross-check

**Files:**
- Create: `src/extract/dialects/index.ts`
- Test: `src/extract/dialects/index.test.ts`

**Interfaces:**
- Consumes: `MAC_VOCABULARY`, `CIGNA_VOCABULARY`, `parseCignaCodingInformation`, `DialectCoding`, `extractHcpcsCodes` (from `article.ts`), `extractPdfText`.
- Produces:
  - `type DialectName = 'mac' | 'cigna'`
  - `interface Dialect { readonly name: DialectName; readonly documentName: string; readonly articleExpectation: 'required' | 'none'; readonly vocabulary: SectionVocabulary; sniff(page1: string): boolean; verifyId(lcdId: string, page1: string): void; extractCoding(cutText: string, lcdId: string): DialectCoding }`
  - `sniffDialect(page1: string): Dialect` — throws unless exactly one dialect matches, error names the known dialects.
  - `sniffPdfDialect(pdfPath: string): Promise<Dialect>` — page-1 convenience for CLI/UI arity checks.

- [ ] **Step 1: Write the failing tests**

```ts
// src/extract/dialects/index.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { sniffDialect, sniffPdfDialect } from './index.ts';

const MAC_PAGE1 = ['Local Coverage Determination (LCD)', 'Glucose Things', 'TEST-L1'].join('\n');
const CIGNA_PAGE1 = ['Medical Coverage Policy', 'Effective Date 1/1/2026', 'Coverage Policy Number............. 0101'].join('\n');

test('sniffs the MAC banner', () => {
  assert.equal(sniffDialect(MAC_PAGE1).name, 'mac');
});

test('sniffs the Cigna banner, dot leaders and all', () => {
  assert.equal(sniffDialect(CIGNA_PAGE1).name, 'cigna');
});

test('no banner: throws naming the known dialects', () => {
  assert.throws(() => sniffDialect('Just some PDF.'), /mac.*cigna|cigna.*mac/s);
});

test('both banners: throws as ambiguous', () => {
  assert.throws(() => sniffDialect(`${MAC_PAGE1}\n${CIGNA_PAGE1}`), /ambiguous/i);
});

test('MAC id cross-check: the filename-derived id must appear on page 1', () => {
  const mac = sniffDialect(MAC_PAGE1);
  mac.verifyId('TEST-L1', MAC_PAGE1); // no throw
  assert.throws(() => mac.verifyId('TEST-L2', MAC_PAGE1), /TEST-L2/);
});

test('Cigna id cross-check: CIGNA-<policy number> must match the banner field', () => {
  const cigna = sniffDialect(CIGNA_PAGE1);
  cigna.verifyId('CIGNA-0101', CIGNA_PAGE1); // no throw
  assert.throws(() => cigna.verifyId('CIGNA-0158', CIGNA_PAGE1), /0101/);
  assert.throws(() => cigna.verifyId('0101', CIGNA_PAGE1), /CIGNA-0101/);
});

test('sniffPdfDialect reads page 1 of a real PDF', async () => {
  assert.equal((await sniffPdfDialect('test/fixtures/two-page-policy.pdf')).name, 'mac');
  assert.equal((await sniffPdfDialect('test/fixtures/CIGNA-0101.pdf')).name, 'cigna');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/extract/dialects/index.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/extract/dialects/index.ts
import type { SectionVocabulary } from '../sections.ts';
import { extractHcpcsCodes } from '../article.ts';
import { extractPdfText } from '../pdf-text.ts';
import { MAC_VOCABULARY } from './mac.ts';
import { CIGNA_VOCABULARY } from './cigna.ts';
import { parseCignaCodingInformation } from './cigna-coding.ts';
import type { DialectCoding } from './cigna-coding.ts';

export type DialectName = 'mac' | 'cigna';

/**
 * A dialect is a publisher FORMAT (all MAC LCDs share one, all Cigna coverage
 * policies share one) — never a plan or a document. It owns everything the
 * pipeline reads from document structure; the stages themselves stay shared.
 */
export interface Dialect {
  readonly name: DialectName;
  /** How the LLM prompt names this kind of document. */
  readonly documentName: string;
  /** Whether a paired policy article is part of this publisher's document set. */
  readonly articleExpectation: 'required' | 'none';
  readonly vocabulary: SectionVocabulary;
  sniff(page1: string): boolean;
  /** Cross-checks the filename-derived id against what page 1 says about itself. */
  verifyId(lcdId: string, page1: string): void;
  extractCoding(cutText: string, lcdId: string): DialectCoding;
}

const MAC_BANNER = /Local\s+Coverage\s+Determination\s+\(LCD\)/;
const CIGNA_BANNER = /Medical\s+Coverage\s+Policy/;
const CIGNA_NUMBER_FIELD = /Coverage\s+Policy\s+Number[^0-9]*([0-9]{3,4})/;

const MAC_DIALECT: Dialect = {
  name: 'mac',
  documentName: 'Medicare coverage policy',
  articleExpectation: 'required',
  vocabulary: MAC_VOCABULARY,
  sniff: (page1) => MAC_BANNER.test(page1),
  verifyId: (lcdId, page1) => {
    const tokens = new Set(page1.split(/\s+/));
    if (!tokens.has(lcdId)) {
      throw new Error(
        `Filename-derived id "${lcdId}" does not appear on the document's first page — ` +
          'the fixture file is probably misnamed for the PDF it contains.',
      );
    }
  },
  extractCoding: (cutText) => {
    const { codes, warnings } = extractHcpcsCodes(cutText, { onMissingHeading: 'warn' });
    return { coveredCodes: codes, denialReasons: [], warnings };
  },
};

const CIGNA_DIALECT: Dialect = {
  name: 'cigna',
  documentName: 'commercial payer coverage policy',
  articleExpectation: 'none',
  vocabulary: CIGNA_VOCABULARY,
  sniff: (page1) => CIGNA_BANNER.test(page1) && CIGNA_NUMBER_FIELD.test(page1),
  verifyId: (lcdId, page1) => {
    const number = CIGNA_NUMBER_FIELD.exec(page1)?.[1];
    const expected = `CIGNA-${number ?? '?'}`;
    if (lcdId !== expected) {
      throw new Error(
        `Filename-derived id "${lcdId}" does not match the document: page 1 declares ` +
          `Coverage Policy Number ${number ?? '(unreadable)'}, so the fixture must be named ${expected}.pdf.`,
      );
    }
  },
  extractCoding: (cutText, lcdId) => parseCignaCodingInformation(cutText, lcdId),
};

export const DIALECTS: readonly Dialect[] = [MAC_DIALECT, CIGNA_DIALECT];

export function sniffDialect(page1: string): Dialect {
  const matches = DIALECTS.filter((dialect) => dialect.sniff(page1));
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  const known = DIALECTS.map((d) => d.name).join(', ');
  if (matches.length === 0) {
    throw new Error(
      `Could not recognise the document's publisher from its first page. Known dialects: ${known}. ` +
        'If this is a new payer format, it needs a dialect in src/extract/dialects/.',
    );
  }
  throw new Error(
    `Ambiguous document: first page matches more than one dialect (${matches.map((d) => d.name).join(', ')}).`,
  );
}

/** Page-1 sniff for CLI/UI intake checks, before any expensive extraction. */
export async function sniffPdfDialect(pdfPath: string): Promise<Dialect> {
  const { pages } = await extractPdfText(pdfPath);
  return sniffDialect(pages[0] ?? '');
}
```

- [ ] **Step 4: Run to verify pass, typecheck, commit**

Run: `node --test src/extract/dialects/index.test.ts && npx tsc --noEmit`

```bash
git add src/extract/dialects/index.ts src/extract/dialects/index.test.ts
git commit -m "extract: dialect interface, page-1 sniffer, and id cross-check"
```

---

### Task 6: Dialect-dispatching extraction + snapshots

Wire the sniffer into `extractLcd`, thread `documentName` into the LLM prompt, and carry `dialect` + `denialReasons` through the snapshot files.

**Files:**
- Modify: `src/extract/extract.ts`
- Modify: `src/extract/structure.ts` (`StructureInput` gains `documentName`)
- Modify: `src/extract/snapshot.ts` (`readExtractedSnapshot` tolerates/passes the new optional fields)
- Modify: `src/extract/structure.test.ts` (pass `documentName`), `src/extract/extract.test.ts`
- Test: extend `src/extract/extract.test.ts` with the Cigna-path integration test

**Interfaces:**
- Consumes: `sniffDialect`, `Dialect` (Task 5); `splitSections`/`cutAtTerminal` (Task 2); `PolicyDenialReason` (Task 4).
- Produces: `ExtractionResult` gains `readonly dialect: DialectName` and `readonly denialReasons?: readonly PolicyDenialReason[]`; the `hcpcsCodes` field now carries the dialect's covered-code table output (MAC: LCD table as before; Cigna: MN-table codes, CPT + HCPCS). `StructureInput` is `{ lcdId, sections, documentName }`. Snapshots (`fixtures/<id>.extracted.json`) serialize the new fields; old MAC snapshots (no `dialect` key) must still load.

- [ ] **Step 1: Write the failing integration test**

Add to `src/extract/extract.test.ts` (reuse the file's existing `fakeLlm` helper):

```ts
const CIGNA_SAMPLE_PDF = 'test/fixtures/CIGNA-0101.pdf';

function cignaReplies(): string[] {
  // One combined indications+limitations block => one LLM call.
  return [
    JSON.stringify({
      requirements: [
        { text: 'Widget therapy requires a documented diagnosis of testitis.', category: 'indication' },
        { text: 'Widget removal as a stand-alone procedure is not medically necessary.', category: 'limitation' },
      ],
    }),
  ];
}

test('extractLcd dispatches the Cigna dialect end to end', async () => {
  const result = await extractLcd(CIGNA_SAMPLE_PDF, fakeLlm(cignaReplies()));
  assert.equal(result.dialect, 'cigna');
  assert.equal(result.lcdId, 'CIGNA-0101');
  assert.deepEqual(result.hcpcsCodes, [
    { system: 'CPT', code: '12345' },
    { system: 'HCPCS', code: 'A1234' },
  ]);
  assert.equal(result.denialReasons?.length, 2);
  assert.equal(result.denialReasons?.[0]?.stance, 'not-medically-necessary');
  assert.deepEqual(result.denialReasons?.[0]?.appliesTo, [{ system: 'CPT', code: '23456' }]);
  assert.equal(result.requirements.length, 2);
});

test('extractLcd keeps the MAC path: dialect recorded, no denialReasons', async () => {
  const result = await extractLcd(SAMPLE_PDF, fakeLlm(replies()));
  assert.equal(result.dialect, 'mac');
  assert.equal(result.denialReasons, undefined);
});

test('extractLcd fails loud on a filename/document id mismatch', async () => {
  // CIGNA-0101.pdf copied under a wrong name must be rejected at intake.
  const dir = await mkdtemp(join(tmpdir(), 'extract-idcheck-'));
  const wrongName = join(dir, 'CIGNA-0999.pdf');
  await copyFile(CIGNA_SAMPLE_PDF, wrongName);
  await assert.rejects(() => extractLcd(wrongName, fakeLlm(cignaReplies())), /CIGNA-0101/);
});
```

(Add the `mkdtemp`/`tmpdir`/`join`/`copyFile` imports the file doesn't already have.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/extract/extract.test.ts`
Expected: FAIL — `result.dialect` undefined, Cigna PDF unsniffed.

- [ ] **Step 3: Implement**

New `src/extract/extract.ts` (whole file):

```ts
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import type { CodeRef, PolicyDenialReason, Requirement } from '../types.ts';
import type { LlmClient } from './llm-client.ts';
import { extractPdfText } from './pdf-text.ts';
import { cutAtTerminal, splitSections } from './sections.ts';
import { structureRequirements } from './structure.ts';
import { sniffDialect } from './dialects/index.ts';
import type { DialectName } from './dialects/index.ts';

export interface ExtractionResult {
  readonly lcdId: string;
  /** Which publisher format the document sniffed as. */
  readonly dialect: DialectName;
  /** sha256 of the extracted source text, so a re-run detects a changed PDF. */
  readonly sourceHash: string;
  readonly requirements: readonly Requirement[];
  /**
   * The policy's own covered-code table(s). MAC: the LCD's "CPT/HCPCS Codes"
   * table (post-2019 MCD documents split coding facts unpredictably between
   * the LCD and its policy article, so the graph load unions this list with
   * the article's). Cigna: the medically-necessary stance tables.
   */
  readonly hcpcsCodes: readonly CodeRef[];
  /** Present for single-document dialects whose policy states its own denial reasons. */
  readonly denialReasons?: readonly PolicyDenialReason[];
  readonly warnings: readonly string[];
}

/** Fixtures are keyed by LCD id, so the filename is the id. */
export function lcdIdFromPath(pdfPath: string): string {
  return basename(pdfPath, extname(pdfPath));
}

export async function extractLcd(pdfPath: string, llm: LlmClient): Promise<ExtractionResult> {
  const lcdId = lcdIdFromPath(pdfPath);
  const { pages, text } = await extractPdfText(pdfPath);
  const page1 = pages[0] ?? '';
  const dialect = sniffDialect(page1);
  dialect.verifyId(lcdId, page1);

  const cutText = cutAtTerminal(text, dialect.vocabulary.terminal);
  const { sections, warnings } = splitSections(cutText, dialect.vocabulary);
  const requirements = await structureRequirements(
    { lcdId, sections, documentName: dialect.documentName },
    llm,
  );
  const coding = dialect.extractCoding(cutText, lcdId);

  return {
    lcdId,
    dialect: dialect.name,
    sourceHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    requirements,
    hcpcsCodes: coding.coveredCodes,
    ...(coding.denialReasons.length > 0 ? { denialReasons: coding.denialReasons } : {}),
    warnings: [...warnings, ...coding.warnings],
  };
}
```

In `src/extract/structure.ts`:
- `StructureInput` gains `readonly documentName: string;`
- `buildPrompt(body, categories)` becomes `buildPrompt(body, categories, documentName)` and its first line becomes `` `You are extracting discrete coverage requirements from a ${documentName}.` ``
- `structureRequirements` threads `input.documentName` through.
- Update `src/extract/structure.test.ts` call sites to pass `documentName: 'Medicare coverage policy'`.

In `src/extract/snapshot.ts`: the new fields serialize via the existing `JSON.stringify(result)` untouched. In `readExtractedSnapshot`, keep `ExtractionResult.dialect` honest for pre-dialect MAC snapshots (which lack the key) by defaulting it on read, after the existing shape checks:

```ts
  const result = parsed as unknown as ExtractionResult;
  // Snapshots written before the dialect seam are all MAC by construction.
  return result.dialect === undefined ? { ...result, dialect: 'mac' } : result;
```

(`denialReasons` stays genuinely optional on the type, so absence needs no defaulting.)

- [ ] **Step 4: Run the affected tests**

Run: `node --test src/extract/ test/cli-extract.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit && npm test` (live gate included — MAC snapshots unchanged, so the gate behaves as before).

```bash
git add src/extract/extract.ts src/extract/structure.ts src/extract/structure.test.ts src/extract/extract.test.ts src/extract/snapshot.ts
git commit -m "extract: dialect-dispatching extractLcd with sniff + id cross-check"
```

---

### Task 7: Graph — APPLIES_TO, policy-anchored DEFINES, validator update

**Files:**
- Modify: `src/graph/schema.ts` (REL.APPLIES_TO + TODO update)
- Modify: `src/graph/write.ts` (LCD-side denial upserts + stale cleanup)
- Modify: `src/graph/validate.ts` (orphan-code accepts APPLIES_TO)
- Test: `src/graph/write.test.ts`, `src/graph/validate.test.ts` (live Neo4j, `TEST-W-`/`TEST-V-` namespaces, following the files' existing before/after cleanup pattern)

**Interfaces:**
- Consumes: `LcdInput.denialReasons?: readonly PolicyDenialReason[]` (Task 4).
- Produces: `REL.APPLIES_TO = 'APPLIES_TO'`; `loadSubgraph` writes, for an LCD with `denialReasons`: `(lcd)-[:DEFINES]->(d:DenialReason {id, text, stance})` and `(d)-[:APPLIES_TO]->(c:Code)`, idempotently, with stale-edge cleanup. Consumed by Task 8's read.

- [ ] **Step 1: Write the failing write tests**

Add to `src/graph/write.test.ts`, following its existing fixture-builder style:

```ts
function cignaLcdFixture(): LcdInput {
  return {
    id: 'TEST-W-CIG1',
    sourceHash: 'TEST-W-hash-cig',
    requirements: [{ id: 'TEST-W-CIG1-R1', text: 'Criterion.', ordinal: 1, category: 'indication' }],
    coveredCodes: [{ system: 'CPT', code: 'TEST-W-11111' }],
    denialReasons: [
      {
        id: 'TEST-W-CIG1-D1',
        text: 'Stand-alone removal is not medically necessary.',
        stance: 'not-medically-necessary',
        appliesTo: [{ system: 'CPT', code: 'TEST-W-22222' }],
      },
    ],
  };
}

test('an articleless LCD with denialReasons writes DEFINES from the LCD and APPLIES_TO to codes', async () => {
  await loadSubgraph(graph, { lcd: cignaLcdFixture() });
  const rows = await graph.run(`
    MATCH (:LCD {id: 'TEST-W-CIG1'})-[:DEFINES]->(d:DenialReason)-[:APPLIES_TO]->(c:Code)
    RETURN d.id AS id, d.stance AS stance, c.code AS code
  `);
  assert.deepEqual(rows, [{ id: 'TEST-W-CIG1-D1', stance: 'not-medically-necessary', code: 'TEST-W-22222' }]);
});

test('re-loading with a changed denial set removes stale DEFINES and APPLIES_TO edges', async () => {
  await loadSubgraph(graph, { lcd: cignaLcdFixture() });
  await loadSubgraph(graph, {
    lcd: {
      ...cignaLcdFixture(),
      denialReasons: [
        { id: 'TEST-W-CIG1-D2', text: 'Different reason.', stance: 'experimental-investigational', appliesTo: [] },
      ],
    },
  });
  const defines = await graph.run(`
    MATCH (:LCD {id: 'TEST-W-CIG1'})-[:DEFINES]->(d:DenialReason) RETURN d.id AS id ORDER BY id
  `);
  assert.deepEqual(defines, [{ id: 'TEST-W-CIG1-D2' }]);
  const applies = await graph.run(`
    MATCH (:DenialReason {id: 'TEST-W-CIG1-D1'})-[r:APPLIES_TO]->() RETURN count(r) AS n
  `);
  assert.equal(Number(applies[0]?.n ?? -1), 0);
});
```

(Extend `cleanupTestData` only if the existing `TEST-W-` prefix match doesn't already catch the new ids/codes — it does, since all values above start with `TEST-W-`.)

And in `src/graph/validate.test.ts`, following its existing style:

```ts
test('a code reachable only via APPLIES_TO is not an orphan', async () => {
  await graph.run(`
    CREATE (d:DenialReason {id: 'TEST-V-AP-D1', text: 'x'})
    CREATE (c:Code {system: 'CPT', code: 'TEST-V-AP-1'})
    CREATE (d)-[:APPLIES_TO]->(c)
    CREATE (:Article {id: 'TEST-V-AP-A1'})-[:DEFINES]->(d)
  `);
  const report = await validateGraph(graph);
  assert.ok(!report.issues.some((issue) => issue.detail.includes('TEST-V-AP-1')));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose up -d && node --test src/graph/write.test.ts src/graph/validate.test.ts`
Expected: FAIL — `APPLIES_TO` unknown, no LCD-side denial writes, orphan false positive.

- [ ] **Step 3: Implement**

`src/graph/schema.ts` — extend `REL`:

```ts
export const REL = {
  REQUIRES: 'REQUIRES',
  COVERS: 'COVERS',
  HAS_ARTICLE: 'HAS_ARTICLE',
  LISTS: 'LISTS',
  DEFINES: 'DEFINES',
  APPLIES_TO: 'APPLIES_TO',
} as const;
```

Update the module's doc comments: the label/relationship counts ("five") change to six relationships, and add below the Enterprise TODO:

```ts
// (Requirement)-[:DIAGNOSIS_OF]-> and [:FAILS_AS]-> remain deliberately
// unimplemented (see CLAUDE.md "Graph model"). APPLIES_TO landed 2026-08-22
// for the narrower stated-grouping case: a policy whose code tables are
// headed by the stance statement itself (Cigna) states the code↔statement
// link, so recording it is a fact, not an inference. MAC documents do not
// state it, so the MAC dialect never emits APPLIES_TO.
```

`src/graph/write.ts` — in `loadSubgraph`, after the existing `cleanupStaleCovers` call, add:

```ts
  if (lcd.denialReasons !== undefined) {
    await upsertLcdDenialReasons(graph, lcd);
    await upsertAppliesTo(graph, lcd);
    // Order matters: stale APPLIES_TO edges are found by walking DEFINES, so
    // they must be cleaned while the stale DEFINES edges still exist.
    await cleanupStaleAppliesTo(graph, lcd);
    await cleanupStaleLcdDefines(graph, lcd);
  }
```

and the four functions (note `?? []` narrowing since `denialReasons` is optional):

```ts
async function upsertLcdDenialReasons(graph: Graph, lcd: LcdInput): Promise<void> {
  await graph.run(
    `
    MATCH (lcd:${NODE.LCD} {id: $lcdId})
    UNWIND $denialReasons AS dr
    MERGE (d:${NODE.DENIAL_REASON} {id: dr.id})
    SET d.text = dr.text, d.stance = dr.stance
    MERGE (lcd)-[:${REL.DEFINES}]->(d)
    `,
    {
      lcdId: lcd.id,
      denialReasons: (lcd.denialReasons ?? []).map(({ id, text, stance }) => ({ id, text, stance: stance ?? null })),
    },
  );
}

async function upsertAppliesTo(graph: Graph, lcd: LcdInput): Promise<void> {
  await graph.run(
    `
    UNWIND $pairs AS pair
    MATCH (d:${NODE.DENIAL_REASON} {id: pair.denialReasonId})
    MERGE (c:${NODE.CODE} {system: pair.system, code: pair.code})
    MERGE (d)-[:${REL.APPLIES_TO}]->(c)
    `,
    {
      pairs: (lcd.denialReasons ?? []).flatMap((dr) =>
        dr.appliesTo.map((code) => ({ denialReasonId: dr.id, system: code.system, code: code.code })),
      ),
    },
  );
}

async function cleanupStaleLcdDefines(graph: Graph, lcd: LcdInput): Promise<void> {
  await graph.run(
    `
    MATCH (lcd:${NODE.LCD} {id: $lcdId})-[rel:${REL.DEFINES}]->(d:${NODE.DENIAL_REASON})
    WHERE NOT d.id IN $denialReasonIds
    DELETE rel
    `,
    { lcdId: lcd.id, denialReasonIds: (lcd.denialReasons ?? []).map((reason) => reason.id) },
  );
}

async function cleanupStaleAppliesTo(graph: Graph, lcd: LcdInput): Promise<void> {
  await graph.run(
    `
    MATCH (lcd:${NODE.LCD} {id: $lcdId})-[:${REL.DEFINES}]->(d:${NODE.DENIAL_REASON})-[rel:${REL.APPLIES_TO}]->(c:${NODE.CODE})
    WHERE NOT any(pair IN $pairs WHERE pair.denialReasonId = d.id AND pair.system = c.system AND pair.code = c.code)
    DELETE rel
    `,
    {
      lcdId: lcd.id,
      pairs: (lcd.denialReasons ?? []).flatMap((dr) =>
        dr.appliesTo.map((code) => ({ denialReasonId: dr.id, system: code.system, code: code.code })),
      ),
    },
  );
}
```

`src/graph/validate.ts` — in `findOrphanCodes`, extend the WHERE clause:

```cypher
WHERE NOT (()-[:${REL.COVERS}]->(c)) AND NOT (()-[:${REL.LISTS}]->(c)) AND NOT (()-[:${REL.APPLIES_TO}]->(c))
```

and update the issue `detail` string to `has no incoming COVERS, LISTS, or APPLIES_TO relationship`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/graph/`
Expected: PASS (needs the Neo4j container up).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/graph/schema.ts src/graph/write.ts src/graph/validate.ts src/graph/write.test.ts src/graph/validate.test.ts
git commit -m "graph: APPLIES_TO relationship; policy-anchored DEFINES for single-document dialects"
```

---

### Task 8: Read-shape hoist + review console

Hoist `denialReasons` (with `appliesTo`) to the top level of `ApprovedSubgraph`, sourced from whichever node DEFINES them; make the UI's article upload optional with dialect-checked arity.

**Files:**
- Modify: `src/graph/read.ts`
- Modify: `src/fhir/test-support.ts` (subgraph fixture shape)
- Modify: `src/ui/server.ts` (optional `articlePdf`, arity 400s, `denialReasons` pass-through, `sniffPdfDialect` in `ServerDeps`)
- Modify: `src/ui/index.html` (denial list reads the hoisted field; article file input optional)
- Test: `src/graph/read.test.ts`, `src/ui/server.test.ts`

**Interfaces:**
- Consumes: Task 7's graph shape; `sniffPdfDialect` (Task 5).
- Produces: `ApprovedSubgraph` becomes:

```ts
export interface ApprovedSubgraph {
  readonly lcd: { readonly id: string; readonly title?: string; readonly version?: string; readonly status: LcdStatus; readonly sourceHash: string };
  readonly requirements: readonly Requirement[];
  readonly coveredCodes: readonly CodeRef[];
  /** From whichever document DEFINES them — the LCD itself or its article. */
  readonly denialReasons: readonly PolicyDenialReason[];
  readonly article?: { readonly id: string; readonly sourceHash: string; readonly listedCodes: readonly CodeRef[] };
}
```

(`article.denialReasons` is REMOVED; MAC-sourced reasons appear in the top-level list with `appliesTo: []` and no `stance`.)

- [ ] **Step 1: Write the failing read tests**

Add to `src/graph/read.test.ts`, following its existing seeding style (`TEST-R-` namespace):

```ts
test('denialReasons are hoisted and source-agnostic, with appliesTo collected', async () => {
  await graph.run(`
    CREATE (lcd:LCD {id: 'TEST-R-CIG1', status: 'draft', sourceHash: 'TEST-R-h'})
    CREATE (d:DenialReason {id: 'TEST-R-CIG1-D1', text: 'Not medically necessary.', stance: 'not-medically-necessary'})
    CREATE (c:Code {system: 'CPT', code: 'TEST-R-11111'})
    CREATE (lcd)-[:DEFINES]->(d)
    CREATE (d)-[:APPLIES_TO]->(c)
  `);
  const subgraph = await readSubgraph(graph, 'TEST-R-CIG1');
  assert.equal(subgraph.article, undefined);
  assert.deepEqual(subgraph.denialReasons, [
    {
      id: 'TEST-R-CIG1-D1',
      text: 'Not medically necessary.',
      stance: 'not-medically-necessary',
      appliesTo: [{ system: 'CPT', code: 'TEST-R-11111' }],
    },
  ]);
});

test('article-sourced denial reasons appear in the same top-level list', async () => {
  await graph.run(`
    CREATE (lcd:LCD {id: 'TEST-R-MAC1', status: 'draft', sourceHash: 'TEST-R-h2'})
    CREATE (a:Article {id: 'TEST-R-MAC1-A', sourceHash: 'TEST-R-h3'})
    CREATE (d:DenialReason {id: 'TEST-R-MAC1-A-D1', text: 'Denied as not reasonable.'})
    CREATE (lcd)-[:HAS_ARTICLE]->(a)
    CREATE (a)-[:DEFINES]->(d)
  `);
  const subgraph = await readSubgraph(graph, 'TEST-R-MAC1');
  assert.equal(subgraph.article?.id, 'TEST-R-MAC1-A');
  assert.equal(subgraph.denialReasons.length, 1);
  assert.deepEqual(subgraph.denialReasons[0]?.appliesTo, []);
  assert.ok(!('denialReasons' in (subgraph.article ?? {})));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/graph/read.test.ts`
Expected: FAIL — shape mismatch.

- [ ] **Step 3: Implement the read change**

In `src/graph/read.ts`: replace the article-anchored denial query block with a source-agnostic one that runs for every LCD (not just those with an article), and drop `denialReasons` from the article object:

```ts
  const denialReasonRows = await graph.run(
    `
    MATCH (lcd:${NODE.LCD} {id: $lcdId})
    OPTIONAL MATCH (lcd)-[:${REL.HAS_ARTICLE}]->(a:${NODE.ARTICLE})
    WITH lcd, a
    MATCH (src)-[:${REL.DEFINES}]->(d:${NODE.DENIAL_REASON})
    WHERE src = lcd OR src = a
    OPTIONAL MATCH (d)-[:${REL.APPLIES_TO}]->(c:${NODE.CODE})
    RETURN properties(d) AS d, [x IN collect(c) | {system: x.system, code: x.code}] AS appliesTo
    ORDER BY d.id
    `,
    { lcdId },
  );
  const denialReasons: PolicyDenialReason[] = denialReasonRows.map((row) => {
    const props = row.d as { id: string; text: string; stance?: DenialStance | null };
    return {
      id: props.id,
      text: props.text,
      ...(props.stance !== undefined && props.stance !== null ? { stance: props.stance } : {}),
      appliesTo: row.appliesTo as CodeRef[],
    };
  });
```

Include `denialReasons` in both return paths of `readSubgraph`, remove the per-article denial query, and update imports (`PolicyDenialReason`, `DenialStance` from `../types.ts`; drop `DenialReason` if now unused).

Update `src/fhir/test-support.ts`: move its `denialReasons: [...]` out of the `article` object to the subgraph top level, adding `appliesTo: []` to each entry.

- [ ] **Step 4: Run graph + fhir tests**

Run: `node --test src/graph/ src/fhir/`
Expected: PASS. Any *existing* test in `read.test.ts` (or elsewhere) that asserts `subgraph.article.denialReasons` moves its assertion to the hoisted top-level `subgraph.denialReasons` (each entry gaining `appliesTo: []`) — the test's subject stays the same, only the shape moves.

- [ ] **Step 5: Write the failing UI tests**

Add to `src/ui/server.test.ts`, following its existing deps-stubbing style (it already fabricates `ServerDeps`; add a `sniffPdfDialect` stub to the fabricated deps — returning `{ articleExpectation: 'required' }` shaped minimally as the new dep type requires):

```ts
test('upload without an article is accepted when the sniffed dialect needs none', async () => {
  // deps.sniffPdfDialect stubbed to resolve { articleExpectation: 'none' }
  // POST multipart with only lcdPdf => 202, job created with articleId undefined.
});

test('upload without an article is rejected 400 when the dialect requires one', async () => {
  // deps.sniffPdfDialect stubbed to resolve { articleExpectation: 'required' }
  // POST multipart with only lcdPdf => 400, error names the article requirement.
});

test('upload WITH an article is rejected 400 when the dialect forbids one', async () => {
  // deps.sniffPdfDialect stubbed to resolve { articleExpectation: 'none' }
  // POST with both files => 400.
});
```

Write these as real tests in the file's existing request-simulation idiom (it exercises the route handler through the same helper the current 400-cases use) — the three comments above describe the arrange/act/assert, not placeholders to leave.

- [ ] **Step 6: Implement the UI changes**

`src/ui/server.ts`:
- `ServerDeps` gains `readonly sniffPdfDialect: typeof sniffPdfDialect;` (imported from `../extract/dialects/index.ts`), wired in the production deps object at the bottom of the file.
- Upload handler: `articlePdf` becomes optional — `const articleFile = formData.get('articlePdf'); const hasArticle = articleFile instanceof File && articleFile.size > 0;`. Keep the 400 on a missing/invalid `lcdPdf`. Validate `articleId` only when present.
- After writing the LCD PDF to `fixtures/`, sniff and enforce arity before creating the job:

```ts
    const dialect = await deps.sniffPdfDialect(lcdPath);
    if (dialect.articleExpectation === 'required' && !hasArticle) {
      return { status: 400, body: { error: `dialect "${dialect.name}" pairs the policy with an article PDF — upload both files` } };
    }
    if (dialect.articleExpectation === 'none' && hasArticle) {
      return { status: 400, body: { error: `dialect "${dialect.name}" is a single-document policy — do not upload an article PDF` } };
    }
```

  (A sniff failure throws; let the route's existing error handling surface it as a 4xx/5xx with the thrown message — follow whatever the handler does with thrown errors today.)
- `runChain` signature becomes `(deps, jobId, lcdPdfPath, articlePdfPath: string | undefined)`; skip `extractArticleAndSnapshot` when undefined; build `lcd` with `...(lcdResult.denialReasons !== undefined ? { denialReasons: lcdResult.denialReasons } : {})`; call `startReview(article === undefined ? { lcd } : { lcd, article })`.
- `jobs.create(lcdId, articleId, …)`: pass `articleId` as `string | undefined` and loosen the job-store type accordingly (check `src/ui/jobs.ts` for the field and make it optional there and in `status.ts` merging if it names articleId).

`src/ui/index.html`:
- Article input: remove `required`, label it `Article PDF (MAC pairs only)`.
- Legend: `Upload a policy (LCD + article pair, or a single-document policy)`.
- Review rendering: replace the `subgraph.article.denialReasons` loop with a top-level block rendered whenever `subgraph.denialReasons.length > 0`:

```js
    if (subgraph.denialReasons.length > 0) {
      reviewContent.appendChild(el('h3', { text: 'Denial reasons' }));
      const denialList = el('ul');
      for (const reason of subgraph.denialReasons) {
        const suffix = reason.appliesTo.length > 0
          ? ` [${reason.appliesTo.map((c) => `${c.system} ${c.code}`).join(', ')}]`
          : '';
        denialList.appendChild(el('li', { text: `${reason.text}${suffix}` }));
      }
      reviewContent.appendChild(denialList);
    }
```

  (Keep DOM APIs / `textContent` — no `innerHTML` for data values.) The article block keeps only its listed-codes rendering.

- [ ] **Step 7: Run UI tests, typecheck, commit**

Run: `node --test src/ui/ && npx tsc --noEmit`

```bash
git add src/graph/read.ts src/graph/read.test.ts src/fhir/test-support.ts src/ui/server.ts src/ui/server.test.ts src/ui/index.html src/ui/jobs.ts src/ui/status.ts
git commit -m "graph+ui: hoist denialReasons out of the article nest; optional article upload with dialect arity"
```

---

### Task 9: CLI arity + fetch script + CPT URI + acceptance-gate skip

**Files:**
- Modify: `cli.ts` (run arity, denialReasons pass-through, articleless-dialect guard, USAGE)
- Modify: `README.md` (run command line + third-fixture fetch note)
- Modify: `src/fhir/profiles.ts` (CPT URI)
- Modify: `test/acceptance.test.ts` (skip-with-message when the PDF is absent)
- Create: `tools/fetch-cigna-0158.sh`
- Modify: `.gitignore`
- Test: `test/cli-run.test.ts`, `src/fhir/profiles.test.ts` (or wherever `codeSystemUri` is tested — check `grep -rn codeSystemUri src/fhir/*.test.ts`)

**Interfaces:**
- Consumes: `sniffPdfDialect` (Task 5), `ExtractionResult.dialect`/`denialReasons` (Task 6).
- Produces: `node cli.ts run <policy.pdf> [article.pdf]` validated against the sniffed dialect; `codeSystemUri('CPT') === 'http://www.ama-assn.org/go/cpt'`.

- [ ] **Step 1: Write the failing tests**

In `test/cli-run.test.ts`, following its existing spawn-based idiom (temp cwd, stub Ollama):

```ts
test('run with a MAC policy and no article fails loud naming the article requirement', async () => {
  // spawn: node cli.ts run <tempFixtures>/two-page-policy.pdf
  // expect exit 1, stderr matching /article/i and /mac/i
});

test('run with a Cigna policy and an article fails loud as single-document', async () => {
  // spawn: node cli.ts run <tempFixtures>/CIGNA-0101.pdf <tempFixtures>/two-page-policy.pdf
  // expect exit 1, stderr matching /single-document/i
});
```

Write these fully in the file's existing helper idiom (it already spawns the CLI and asserts on exit codes/stderr; both fixture PDFs are copied into the temp cwd the same way the existing tests stage `two-page-policy.pdf`).

For the URI, add to the file that currently tests `codeSystemUri`:

```ts
test('CPT maps to the AMA canonical', () => {
  assert.equal(codeSystemUri('CPT'), 'http://www.ama-assn.org/go/cpt');
});
```

- [ ] **Step 2: Run to verify failures**

Run: `node --test test/cli-run.test.ts src/fhir/`
Expected: FAIL — run currently demands both paths unconditionally; CPT unknown.

- [ ] **Step 3: Implement**

`src/fhir/profiles.ts` — add to `CODE_SYSTEM_URIS` (keep the THO-verification comment style):

```ts
  /** THO external code systems — CPT's canonical, verified against terminology.hl7.org. */
  CPT: 'http://www.ama-assn.org/go/cpt',
```

(Verification step: `https://terminology.hl7.org/CodeSystem-CPT.html` states the canonical URL `http://www.ama-assn.org/go/cpt` — confirm character-for-character before committing; if it differs, the published page wins and the test updates with it.)

`cli.ts` — add `import { sniffPdfDialect } from './src/extract/dialects/index.ts';`, then replace `runRun`'s head:

```ts
async function runRun(args: readonly string[]): Promise<void> {
  const [lcdPath, articlePath] = args;
  if (lcdPath === undefined) {
    throw new Error(`run needs a path to the policy PDF (and, for MAC documents, the article PDF).\n\n${USAGE}`);
  }
  await assertFileExists(lcdPath, 'Policy PDF');

  const dialect = await sniffPdfDialect(lcdPath);
  if (dialect.articleExpectation === 'required' && articlePath === undefined) {
    throw new Error(`Dialect "${dialect.name}" pairs the policy with an article PDF: node cli.ts run <lcd.pdf> <article.pdf>\n\n${USAGE}`);
  }
  if (dialect.articleExpectation === 'none' && articlePath !== undefined) {
    throw new Error(`Dialect "${dialect.name}" is a single-document policy — do not pass an article PDF.\n\n${USAGE}`);
  }
  if (articlePath !== undefined) await assertFileExists(articlePath, 'Article PDF');

  const lcdResult = await extractAndSnapshot(lcdPath, ollamaClient());
  const articleResult = articlePath === undefined ? undefined : await extractArticleAndSnapshot(articlePath, ollamaClient());

  const lcd: LcdInput = {
    id: lcdResult.lcdId,
    sourceHash: lcdResult.sourceHash,
    requirements: lcdResult.requirements,
    coveredCodes: unionCodes(lcdResult.hcpcsCodes, articleResult?.hcpcsCodes ?? []),
    ...(lcdResult.denialReasons !== undefined ? { denialReasons: lcdResult.denialReasons } : {}),
  };

  const workflowId = await startReview(
    articleResult === undefined
      ? { lcd }
      : {
          lcd,
          article: {
            id: articleResult.id,
            sourceHash: articleResult.sourceHash,
            listedCodes: articleResult.listedCodes,
            denialReasons: articleResult.denialReasons,
          },
        },
  );
  // …rest of runRun unchanged (workflow id print, awaitReview, project).
```

Also in `runLoad` and `runReviewStart`, extend the `lcd` construction with:

```ts
    ...(snapshot.denialReasons !== undefined ? { denialReasons: snapshot.denialReasons } : {}),
```

and add, right after reading the snapshot in both verbs:

```ts
  if (snapshot.dialect === 'cigna' && articleId !== undefined) {
    throw new Error(`${snapshot.lcdId} is a single-document policy — do not pass an articleId.\n\n${USAGE}`);
  }
```

Update `USAGE`'s run line to `node cli.ts run <policy.pdf> [article.pdf]` with help text `Extract (article for MAC pairs), start review, block for a human signal, then project on approval`, and mirror the same command change in README.md's walkthrough.

`test/acceptance.test.ts` — skip (loudly) when a ground truth exists but its PDF is fetch-gated:

```ts
import { access } from 'node:fs/promises';
// inside the for-loop, before test(...):
const pdfPath = join(FIXTURES_DIR, `${lcdId}.pdf`);
const hasPdf = await access(pdfPath).then(() => true, () => false);
// then pass to the test options:
{
  timeout: EXTRACTION_TIMEOUT_MS,
  skip: hasPdf
    ? false
    : `${pdfPath} missing. Committed fixtures should always be present; fetch-gated fixtures ` +
      '(copyrighted sources, e.g. CIGNA-0158) are downloaded by their tools/fetch-*.sh script.',
}
```

(This amends the spec's "absent PDF fails" line for the gate specifically: a fresh clone must not fail `npm test` over a deliberately-uncommitted copyrighted PDF. The CLI verbs still fail loud on a missing PDF.)

`tools/fetch-cigna-0158.sh` (mode 755):

```bash
#!/usr/bin/env bash
# Cigna coverage policies are copyrighted (unlike public-domain CMS documents),
# so the CIGNA-0158 fixture PDF is fetched, never committed. Stable static
# URL verified 2026-08-22. Extraction pins sourceHash, so an upstream policy
# revision surfaces as a hash change, not silent drift.
set -euo pipefail
cd "$(dirname "$0")/.."
url='https://static.cigna.com/assets/chcp/pdf/coveragePolicies/medical/mm_0158_coveragepositioncriteria_obstructive_sleep_apnea_diag_trtment_svc.pdf'
out='fixtures/CIGNA-0158.pdf'
curl -fL --retry 3 -o "$out" "$url"
echo "fetched $out"
```

`.gitignore` — add:

```
fixtures/CIGNA-0158.pdf
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `node --test test/ src/fhir/ && npx tsc --noEmit`

```bash
chmod +x tools/fetch-cigna-0158.sh
git add cli.ts README.md src/fhir/profiles.ts test/cli-run.test.ts test/acceptance.test.ts tools/fetch-cigna-0158.sh .gitignore
git commit -m "cli: dialect-checked run arity; CPT canonical; fetch-gated Cigna fixture plumbing"
```

---

### Task 10: Live third fixture — ground truth, full chain, docs

Human-gated and live-LLM; run inline in the supervising session, not dispatched. This is the milestone's acceptance evidence.

**Files:**
- Create: `fixtures/CIGNA-0158.pdf` (fetched, gitignored), `fixtures/CIGNA-0158.extracted.json`, `fixtures/CIGNA-0158.expected.json`
- Create: `docs/conformance/CIGNA-0158.md`
- Modify: `CLAUDE.md` (third-fixture facts), `README.md` (walkthrough), `docs/checkpoints/` entry at session end

**Interfaces:** consumes everything above; produces the reviewed ground truth the M1 gate runs against forever after.

- [ ] **Step 1: Fetch and extract live**

Run: `./tools/fetch-cigna-0158.sh`, then `node cli.ts extract fixtures/CIGNA-0158.pdf` (Ollama must be up; takes minutes). Expect: requirements printed; snapshot written; warnings should include the missing-documentation-section finding and nothing alarming. If the sniffer, id check, section split, or coding parse fails on the real document, fix the *dialect* (patterns), never the mechanism, and re-run — each such fix gets its own regression test against a condensed excerpt of the real text, in the style of Tasks 3/4.

- [ ] **Step 2: Line-by-line ground-truth review**

Open the PDF and the extraction side by side. Verify every requirement against the Coverage Policy section (completeness, no invented items, category correctness), and the covered/denial code sets against the Coding Information tables (expected from the live document: MN table CPT+HCPCS incl. 42145/42975/64582/E-codes-absent-C-codes-present per the current revision; not-MN 42140; E/I/U 41512, 41530, 42160, C9727, 42299; dual-stance snoring statement spanning the main table). Correct extraction defects by fixing the pipeline with regression tests — never by hand-editing the snapshot.

- [ ] **Step 3: Pin the ground truth**

Author `fixtures/CIGNA-0158.expected.json` in the reviewed shape (`requirementCount`, `categoryDistribution` — documentation will be 0 — and ≥6 `keyPhrases` chosen from stable, distinctive criterion wording, e.g. the AHI threshold and PAP-intolerance hours). Then run the gate: `node --test test/acceptance.test.ts` — the CIGNA-0158 case must pass repeatedly (run it twice to sample extraction stability, as was done for the MACs).

- [ ] **Step 4: Full chain live**

```bash
node cli.ts load CIGNA-0158                       # expect clean validation report, exit 0
node src/workflow/worker.ts                       # separate shell (restart if already running — reviewStatus/new types)
node cli.ts review-start CIGNA-0158
node cli.ts review-signal <wfId> approve <reviewer> "third fixture"
node cli.ts project CIGNA-0158                    # expect 3 artifacts; DTR Questionnaire with 0 items
node cli.ts validate CIGNA-0158                   # official validator; document CPT-lookup warnings like HCPCS's
```

Also exercise the review console once (`node src/ui/server.ts`, upload the Cigna PDF alone, approve via the UI) — the single-file upload path and hoisted denial-reason rendering (with applied codes) must work live. Verify the empty Questionnaire still validates against `dtr-std-questionnaire`; record the result either way in `docs/conformance/CIGNA-0158.md` alongside the deliberate empty-items finding and its D4 rationale.

- [ ] **Step 5: Docs + memory + commit**

Update CLAUDE.md (a "Third fixture facts" paragraph: dialect seam, CIGNA-0158 counts from the reviewed ground truth, fetch-gated PDF, empty-Questionnaire finding), README's walkthrough (fetch script step; single-document run), and write the session checkpoint. Then:

```bash
git add fixtures/CIGNA-0158.extracted.json fixtures/CIGNA-0158.expected.json docs/conformance/CIGNA-0158.md CLAUDE.md README.md
git commit -m "fixtures: CIGNA-0158 third fixture — reviewed ground truth + full-chain verification"
```

---

## Execution notes

- Tasks 1–9 are deterministic and dispatchable; Task 10 is live + human-gated and belongs to the supervising session.
- Task order is strict: 2 needs 1's fixtures only at its full-sweep step, 5 needs 1's fixtures, 6 needs 2–5, 7 needs 4, 8 needs 5+7, 9 needs 5+6, 10 needs everything.
- If any dispatched task exceeds ~5 files / ~300 LOC of change, stop and report rather than pushing through (workflow discipline).
- After Task 8, restart any running review-console server / Temporal worker before live verification claims (long-lived-process discipline).
