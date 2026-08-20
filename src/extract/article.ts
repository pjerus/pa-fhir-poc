import { createHash } from 'node:crypto';

import type { CodeRef, DenialReason } from '../types.ts';
import { lcdIdFromPath } from './extract.ts';
import type { LlmClient } from './llm-client.ts';
import { extractPdfText } from './pdf-text.ts';
import { cutAtRevisionHistory } from './sections.ts';

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

const MAX_HEADING_WORDS = 12;

/**
 * Article headings follow the same structural shape as LCD section headings
 * (see sections.ts): short, non-sentence lines, sometimes trailing a colon.
 * The colon is stripped before the word-count/period checks apply. Unlike
 * sections.ts, code-list bodies here are single short lines too (a code plus
 * its description, e.g. "E0607 Home blood glucose monitor"), so word count
 * alone cannot tell a heading from a code line -- these article headings are
 * conventionally rendered in all caps, so that is required as well.
 */
function isHeadingLike(rawLine: string): boolean {
  const line = rawLine.trim().replace(/:$/, '');
  if (line === '' || line.endsWith('.')) return false;
  if (line.split(/\s+/).length > MAX_HEADING_WORDS) return false;
  const letters = line.replace(/[^A-Za-z]/g, '');
  return letters !== '' && letters === letters.toUpperCase();
}

/** First index at or after `fromIndex` whose line is heading-like and matches `test`. */
function findHeadingIndex(
  lines: readonly string[],
  test: (headingText: string) => boolean,
  fromIndex = 0,
): number {
  for (let i = fromIndex; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim().replace(/:$/, '');
    if (isHeadingLike(line) && test(line)) return i;
  }
  return -1;
}

function linesOf(text: string): string[] {
  return text.split('\n').map((line) => line.trim());
}

/** Tokens in `lines` matching `shape`, deduplicated in first-seen order. */
function dedupTokens(lines: readonly string[], shape: RegExp): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const line of lines) {
    for (const token of line.split(/[^A-Za-z0-9.]+/)) {
      if (token === '' || !shape.test(token) || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

const ICD10_SUPPORT_HEADING = /ICD-?10.{0,4}CM CODES? THAT SUPPORT MEDICAL NECESSITY/i;
const ICD10_ANY_HEADING = /ICD-?10/i;
const ICD10_CODE_SHAPE = /^[A-TV-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?$/;
const ICD10_HEADING_LABEL = 'ICD-10-CM Codes That Support Medical Necessity';

/**
 * The ICD-10 support-list region runs from its heading to the next ICD-10
 * heading (typically a "DO NOT SUPPORT" group) so codes from later groups
 * are never vacuumed in as supporting codes.
 */
export function extractIcd10Codes(text: string): CodeRef[] {
  const lines = linesOf(text);
  const startIndex = findHeadingIndex(lines, (line) => ICD10_SUPPORT_HEADING.test(line));
  if (startIndex === -1) {
    throw new Error(`Could not find a "${ICD10_HEADING_LABEL}" heading in the article.`);
  }

  const endIndex = findHeadingIndex(lines, (line) => ICD10_ANY_HEADING.test(line), startIndex + 1);
  const region = lines.slice(startIndex + 1, endIndex === -1 ? lines.length : endIndex);

  const codes = dedupTokens(region, ICD10_CODE_SHAPE);
  if (codes.length === 0) {
    throw new Error(`Found the "${ICD10_HEADING_LABEL}" heading but no ICD-10-CM codes beneath it.`);
  }
  return codes.map((code) => ({ system: 'ICD-10-CM', code }));
}

const HCPCS_START_HEADING = /HCPCS CODES?/i;
const HCPCS_ANY_HEADING = /HCPCS/i;
const HCPCS_CODE_SHAPE = /^[A-Z][0-9]{4}$/;
const HCPCS_HEADING_LABEL = 'HCPCS Codes';

/**
 * The HCPCS region runs from its heading to the next heading-like line that
 * is not itself HCPCS-flavoured (e.g. an ICD-10 or non-medical-necessity
 * heading), so codes are not vacuumed from the whole document.
 */
export function extractHcpcsCodes(text: string): CodeRef[] {
  const lines = linesOf(text);
  const startIndex = findHeadingIndex(lines, (line) => HCPCS_START_HEADING.test(line));
  if (startIndex === -1) {
    throw new Error(`Could not find a "${HCPCS_HEADING_LABEL}" heading in the article.`);
  }

  const endIndex = findHeadingIndex(lines, (line) => !HCPCS_ANY_HEADING.test(line), startIndex + 1);
  const region = lines.slice(startIndex + 1, endIndex === -1 ? lines.length : endIndex);

  const codes = dedupTokens(region, HCPCS_CODE_SHAPE);
  if (codes.length === 0) {
    throw new Error(`Found the "${HCPCS_HEADING_LABEL}" heading but no HCPCS codes beneath it.`);
  }
  return codes.map((code) => ({ system: 'HCPCS', code }));
}

const NON_MEDICAL_NECESSITY_HEADING = /NON-?MEDICAL NECESSITY/i;

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
  const lines = linesOf(text);
  const startIndex = findHeadingIndex(lines, (line) => NON_MEDICAL_NECESSITY_HEADING.test(line));
  if (startIndex === -1) {
    return {
      body: lines.join('\n'),
      warnings: [
        'No "Non-Medical Necessity" heading found; using the whole article text for denial-reason extraction.',
      ],
    };
  }

  const endIndex = findHeadingIndex(lines, () => true, startIndex + 1);
  const body = lines.slice(startIndex + 1, endIndex === -1 ? lines.length : endIndex).join('\n');
  return { body, warnings: [] };
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
  const hcpcsCodes = extractHcpcsCodes(text);
  const { denialReasons, warnings } = await extractDenialReasons(text, articleId, llm);

  return { id: articleId, listedCodes, denialReasons, hcpcsCodes, warnings };
}

export async function extractArticle(pdfPath: string, llm: LlmClient): Promise<ArticleExtractionResult> {
  const articleId = lcdIdFromPath(pdfPath);
  const { text } = await extractPdfText(pdfPath);
  const cutText = cutAtRevisionHistory(text);
  const snapshot = await parseArticleText(cutText, articleId, llm);

  return {
    ...snapshot,
    sourceHash: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}
