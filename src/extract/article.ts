import { createHash } from 'node:crypto';

import type { CodeRef, DenialReason } from '../types.ts';
import { MAC_VOCABULARY } from './dialects/mac.ts';
import { lcdIdFromPath } from './extract.ts';
import type { LlmClient } from './llm-client.ts';
import { extractPdfText } from './pdf-text.ts';
import { cutAtTerminal } from './sections.ts';

export interface ArticleSnapshot {
  readonly id: string;
  readonly listedCodes: readonly CodeRef[];
  readonly denialReasons: readonly DenialReason[];
  readonly hcpcsCodes: readonly CodeRef[];
  readonly warnings: readonly string[];
}

export interface ArticleExtractionResult extends ArticleSnapshot {
  /** sha256 of the full extracted source text, so a re-run detects a changed PDF. */
  readonly sourceHash: string;
}

/**
 * Real MCD article headings wrap across lines (a PDF's page-text extraction
 * breaks "...Codes that Support Medical" and "Necessity" onto separate
 * lines) and are not reliably all-caps or single-line ("CPT/HCPCS Codes" vs.
 * "Coding Information"). Per-line heading detection can never find these, so
 * region bounds are located as flat-text regex matches over the whole
 * (already revision-history-cut) source string instead -- `\s+` between
 * words spans a line break the same as a literal space.
 */
interface FlatMatch {
  readonly start: number;
  readonly end: number;
}

function firstMatch(text: string, pattern: RegExp): FlatMatch | null {
  const found = pattern.exec(text);
  return found === null ? null : { start: found.index, end: found.index + found[0].length };
}

/**
 * Whitespace-delimited tokens in `text` whose *entire* token matches `shape`,
 * deduplicated in first-seen order. Splitting on whitespace only (not on
 * punctuation) matters: a punctuation-based split can shear a longer
 * compound token (e.g. an id or a hyphenated pair) into pieces where a
 * fragment coincidentally looks like a real code. Full-matching the
 * whitespace-delimited token instead means a code sitting next to a comma
 * or period (a list item, a sentence) is only recognised when the
 * punctuation itself isn't glued onto the token by the source text.
 */
export function tokensMatching(text: string, shape: RegExp): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of text.split(/\s+/)) {
    if (token === '' || !shape.test(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

const ICD10_SUPPORT_HEADING = /ICD-?10-?CM\s+Codes\s+that\s+Support\s+Medical\s+Necessity/i;
const ICD10_DO_NOT_SUPPORT_HEADING = /ICD-?10-?CM\s+Codes\s+that\s+DO\s+NOT\s+Support/i;
const ICD10_PCS_HEADING = /ICD-?10-?PCS\s+Codes/i;
const ICD10_CODE_SHAPE = /^[A-TV-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?$/;
const ICD10_HEADING_LABEL = 'ICD-10-CM Codes That Support Medical Necessity';

/**
 * The ICD-10 support-list region runs from the end of its heading match to
 * whichever comes first: the "DO NOT Support" group's heading, the
 * ICD-10-PCS heading, or end of text -- so codes from later groups are
 * never vacuumed in as supporting codes.
 */
export function extractIcd10Codes(text: string): CodeRef[] {
  const heading = firstMatch(text, ICD10_SUPPORT_HEADING);
  if (heading === null) {
    throw new Error(`Could not find a "${ICD10_HEADING_LABEL}" heading in the article.`);
  }

  const rest = text.slice(heading.end);
  const boundaries = [firstMatch(rest, ICD10_DO_NOT_SUPPORT_HEADING), firstMatch(rest, ICD10_PCS_HEADING)]
    .filter((match): match is FlatMatch => match !== null)
    .map((match) => match.start);
  const regionEnd = boundaries.length === 0 ? rest.length : Math.min(...boundaries);

  const codes = tokensMatching(rest.slice(0, regionEnd), ICD10_CODE_SHAPE);
  if (codes.length === 0) {
    throw new Error(`Found the "${ICD10_HEADING_LABEL}" heading but no ICD-10-CM codes beneath it.`);
  }
  return codes.map((code) => ({ system: 'ICD-10-CM', code }));
}

const HCPCS_HEADING = /CPT\/?\s*HCPCS\s+Codes?/i;
const HCPCS_CODE_SHAPE = /^[A-Z][0-9]{4}$/;
const HCPCS_HEADING_LABEL = 'CPT/HCPCS Codes';
// Must occupy its own line: some articles reference "the Coding Guidelines
// section below" in prose well before the real heading, and an unanchored
// match would find that mention first.
const CODING_GUIDELINES_HEADING = /(?:^|\n)[ \t]*CODING\s+GUIDELINES[ \t]*(?=\n|$)/i;
const CODING_INFORMATION_HEADING = /Coding\s+Information/i;
const HCPCS_EMPTY_WARNING =
  `No HCPCS codes found under the "${HCPCS_HEADING_LABEL}" heading; ` +
  'recording an empty list rather than a stub.';
const HCPCS_NO_HEADING_WARNING =
  `No "${HCPCS_HEADING_LABEL}" heading found; recording an empty list rather than a stub.`;
// The code table ends where the next top-level region begins. Searched after
// the heading, because articles also carry a "General Information" block near
// the top of the document.
const HCPCS_REGION_END_HEADINGS: readonly RegExp[] = [
  ICD10_SUPPORT_HEADING,
  /General\s+Information/i,
  /Associated\s+Information/i,
];

interface HcpcsResult {
  readonly codes: readonly CodeRef[];
  readonly warnings: readonly string[];
}

export interface HcpcsOptions {
  /**
   * Articles always carry the heading, so a miss there is a parse failure
   * ('throw'). LCDs published after the 2019 MCD restructuring may delegate
   * coding entirely to their article, so a missing heading in an LCD is a
   * fact about the document ('warn').
   */
  readonly onMissingHeading?: 'throw' | 'warn';
}

/**
 * The HCPCS region runs from the end of the "CPT/HCPCS Codes" heading to the
 * next top-level region heading. Only codes inside that explicit table count:
 * prose mentions elsewhere (e.g. "Coding Guidelines") name non-covered and
 * miscoded examples as often as covered items, so they are never a source of
 * coverage facts. A heading genuinely followed by zero codes is recorded as
 * an empty list with a warning instead of thrown.
 */
export function extractHcpcsCodes(text: string, options: HcpcsOptions = {}): HcpcsResult {
  const heading = firstMatch(text, HCPCS_HEADING);
  if (heading === null) {
    if (options.onMissingHeading === 'warn') {
      return { codes: [], warnings: [HCPCS_NO_HEADING_WARNING] };
    }
    throw new Error(`Could not find a "${HCPCS_HEADING_LABEL}" heading in the article.`);
  }

  const rest = text.slice(heading.end);
  const regionEnd = Math.min(
    ...HCPCS_REGION_END_HEADINGS.map((pattern) => firstMatch(rest, pattern)?.start ?? rest.length),
  );
  const codes = tokensMatching(rest.slice(0, regionEnd), HCPCS_CODE_SHAPE);
  if (codes.length === 0) {
    return { codes: [], warnings: [HCPCS_EMPTY_WARNING] };
  }
  return { codes: codes.map((code) => ({ system: 'HCPCS', code })), warnings: [] };
}

const NON_MEDICAL_NECESSITY_HEADING = /NON-?MEDICAL\s+NECESSITY/i;
// The other top-level headings this parser already recognises double as the
// denial-reasons section's closing boundary. ("Next heading-like line" is
// not a usable alternative here: real documents have headings that wrap
// across lines, and code-list lines that are mostly digits and commas with
// one stray capital letter trivially look "all caps".)
const DENIAL_REASON_SECTION_END_HEADINGS = [CODING_GUIDELINES_HEADING, ICD10_SUPPORT_HEADING, HCPCS_HEADING];

interface DenialReasonSection {
  readonly body: string;
  readonly warnings: readonly string[];
}

/**
 * The denial-reasons LLM stage reads only the "non-medical necessity"
 * section when the article has one; a MAC that omits that heading still
 * gets denial reasons out of the whole pre-revision-history text, flagged
 * with a warning rather than failing loud (unlike the deterministic code
 * parsers, prose without a clean heading is exactly what the LLM is for).
 */
function findDenialReasonSection(text: string): DenialReasonSection {
  const heading = firstMatch(text, NON_MEDICAL_NECESSITY_HEADING);
  if (heading === null) {
    return {
      body: text,
      warnings: [
        'No "Non-Medical Necessity" heading found; using the whole article text for denial-reason extraction.',
      ],
    };
  }

  const rest = text.slice(heading.end);
  const boundaries = DENIAL_REASON_SECTION_END_HEADINGS.map((pattern) => firstMatch(rest, pattern)?.start).filter(
    (start): start is number => start !== undefined,
  );
  const bodyEnd = boundaries.length === 0 ? rest.length : Math.min(...boundaries);
  return { body: rest.slice(0, bodyEnd), warnings: [] };
}

function denialReasonSchema(): unknown {
  return {
    type: 'object',
    required: ['denialReasons'],
    properties: {
      denialReasons: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
      },
    },
  };
}

function buildDenialPrompt(body: string): string {
  return [
    'You are extracting distinct denial reasons from a Medicare coverage policy article.',
    '',
    'Return ONLY a JSON object of the form:',
    '{"denialReasons":[{"text":"<one distinct denial rule, e.g. \'will be denied as...\'>"}]}',
    '',
    'Rules:',
    '- One entry per distinct, independently checkable denial rule.',
    '- Do not merge two denial rules into one entry, and do not split one across entries.',
    '- Do not invent denial reasons that are not stated in the text.',
    '- No prose, no markdown fences, no explanation. JSON only.',
    '',
    'Article text:',
    body,
  ].join('\n');
}

function buildRetryPrompt(originalPrompt: string, unusableReply: string, reason: string): string {
  return [
    'Your previous reply could not be used.',
    `Reason: ${reason}`,
    '',
    'This is what you replied:',
    unusableReply,
    '',
    'Reply again with the JSON object only. Start your reply with { and end it with }.',
    'Do not restate the question, do not explain, do not use markdown fences.',
    '',
    originalPrompt,
  ].join('\n');
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ParsedDenialReason {
  readonly text: string;
}

function parseDenialReasons(raw: string): ParsedDenialReason[] {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !('denialReasons' in parsed)) {
    throw new Error('response has no "denialReasons" key');
  }
  const list = (parsed as { denialReasons: unknown }).denialReasons;
  if (!Array.isArray(list)) throw new Error('"denialReasons" is not an array');

  return list.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`denialReason ${index} is not an object`);
    }
    const { text } = item as { text?: unknown };
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error(`denialReason ${index} has no text`);
    }
    return { text: text.trim() };
  });
}

/** One retry, then surrender loudly -- never a partial or invented result. */
async function requestDenialReasons(body: string, llm: LlmClient): Promise<ParsedDenialReason[]> {
  const schema = denialReasonSchema();
  const prompt = buildDenialPrompt(body);

  const first = await llm.complete({ prompt, schema });
  try {
    return parseDenialReasons(first);
  } catch (error) {
    const retry = await llm.complete({
      prompt: buildRetryPrompt(prompt, first, reasonOf(error)),
      schema,
    });
    try {
      return parseDenialReasons(retry);
    } catch (retryError) {
      throw new Error(
        [
          'Denial-reason extraction failed twice; refusing to emit partial or invented reasons.',
          `First attempt rejected because: ${reasonOf(error)}`,
          `Retry rejected because: ${reasonOf(retryError)}`,
          '',
          'Raw first reply:',
          first,
          '',
          'Raw retry reply:',
          retry,
        ].join('\n'),
      );
    }
  }
}

async function extractDenialReasons(
  text: string,
  articleId: string,
  llm: LlmClient,
): Promise<{ denialReasons: DenialReason[]; warnings: readonly string[] }> {
  const { body, warnings } = findDenialReasonSection(text);
  const parsed = await requestDenialReasons(body, llm);
  const denialReasons = parsed.map((reason, index) => ({
    id: `${articleId}-D${index + 1}`,
    text: reason.text,
  }));
  return { denialReasons, warnings };
}

/**
 * The testable seam: parses already-extracted, already-revision-history-cut
 * article text. ICD-10 and HCPCS codes are deterministic (no LLM call);
 * denial reasons are the one non-deterministic stage.
 */
export async function parseArticleText(
  text: string,
  articleId: string,
  llm: LlmClient,
): Promise<ArticleSnapshot> {
  const listedCodes = extractIcd10Codes(text);
  const { codes: hcpcsCodes, warnings: hcpcsWarnings } = extractHcpcsCodes(text);
  const { denialReasons, warnings: denialWarnings } = await extractDenialReasons(text, articleId, llm);

  return {
    id: articleId,
    listedCodes,
    denialReasons,
    hcpcsCodes,
    warnings: [...hcpcsWarnings, ...denialWarnings],
  };
}

export async function extractArticle(pdfPath: string, llm: LlmClient): Promise<ArticleExtractionResult> {
  const articleId = lcdIdFromPath(pdfPath);
  const { text } = await extractPdfText(pdfPath);
  const cutText = cutAtTerminal(text, MAC_VOCABULARY.terminal);
  const snapshot = await parseArticleText(cutText, articleId, llm);

  return {
    ...snapshot,
    sourceHash: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}
