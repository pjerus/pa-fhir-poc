import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import type { CodeRef, Requirement } from '../types.ts';
import { extractHcpcsCodes } from './article.ts';
import type { LlmClient } from './llm-client.ts';
import { extractPdfText } from './pdf-text.ts';
import { cutAtRevisionHistory, splitSections } from './sections.ts';
import { structureRequirements } from './structure.ts';

export interface ExtractionResult {
  readonly lcdId: string;
  /** sha256 of the extracted source text, so a re-run detects a changed PDF. */
  readonly sourceHash: string;
  readonly requirements: readonly Requirement[];
  /**
   * Codes from the LCD's own "CPT/HCPCS Codes" table. Post-2019 MCD documents
   * split coding facts unpredictably between the LCD and its policy article,
   * so the graph load unions this list with the article's.
   */
  readonly hcpcsCodes: readonly CodeRef[];
  readonly warnings: readonly string[];
}

/** Fixtures are keyed by LCD id, so the filename is the id. */
export function lcdIdFromPath(pdfPath: string): string {
  return basename(pdfPath, extname(pdfPath));
}

export async function extractLcd(pdfPath: string, llm: LlmClient): Promise<ExtractionResult> {
  const lcdId = lcdIdFromPath(pdfPath);
  const { text } = await extractPdfText(pdfPath);
  const { sections, warnings } = splitSections(text);
  const requirements = await structureRequirements({ lcdId, sections }, llm);
  const hcpcs = extractHcpcsCodes(cutAtRevisionHistory(text), { onMissingHeading: 'warn' });

  return {
    lcdId,
    sourceHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    requirements,
    hcpcsCodes: hcpcs.codes,
    warnings: [...warnings, ...hcpcs.warnings],
  };
}
