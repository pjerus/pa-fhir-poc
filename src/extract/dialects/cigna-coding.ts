import type { CodeRef, DenialStance, PolicyDenialReason } from '../../types.ts';
import { tokensMatching } from '../article.ts';

export interface DialectCoding {
  readonly coveredCodes: readonly CodeRef[];
  readonly denialReasons: readonly PolicyDenialReason[];
  readonly warnings: readonly string[];
}

// Region bounds are located as whole-line exact headings, not flat-text
// matches: the page-1 table of contents repeats both headings with trailing
// dot leaders and page numbers ("Coding Information ......... 4"), and a
// flat match would anchor the region on that TOC sliver.
const CODING_INFORMATION_HEADING = /^Coding\s+Information$/i;
const REGION_END_HEADING = /^General\s+Background$/i;

interface HeadingLine {
  /** Char offset of the line's start within the searched text. */
  readonly start: number;
  /** Char offset just past the line (past its newline, or end of text). */
  readonly end: number;
}

/** First line that IS the heading (trimmed, whole line) — TOC entries never match. */
function findHeadingLine(text: string, pattern: RegExp): HeadingLine | null {
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length;
    if (pattern.test(line.trim())) {
      return { start: offset, end: Math.min(lineEnd + 1, text.length) };
    }
    offset = lineEnd + 1;
  }
  return null;
}

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
  const heading = findHeadingLine(cutText, CODING_INFORMATION_HEADING);
  if (heading === null) {
    throw new Error('Could not find a "Coding Information" heading in the policy document.');
  }
  const afterHeading = cutText.slice(heading.end);
  const endHeading = findHeadingLine(afterHeading, REGION_END_HEADING);
  const region = endHeading === null ? afterHeading : afterHeading.slice(0, endHeading.start);

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
