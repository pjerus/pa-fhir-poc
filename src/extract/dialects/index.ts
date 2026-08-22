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
