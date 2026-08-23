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
