import { readFile } from 'node:fs/promises';

import { extractText, getDocumentProxy } from 'unpdf';

export interface PdfText {
  /** Every page concatenated, one page per entry. */
  readonly pages: readonly string[];
  /** All pages merged into a single string. */
  readonly text: string;
  readonly totalPages: number;
}

/**
 * Some Medicare Coverage Database PDF exports carry layered text: a line's
 * content is duplicated in place, e.g. "Coding GuidelinesCoding
 * GuidelinesCoding Guidelines". Collapse a line that is exactly one
 * substring repeated 2+ times down to a single instance of that substring.
 * Legitimate text that merely repeats a short word is left untouched,
 * because it is not divisible into equal, whole-line-spanning repeats.
 */
function collapseRepeatedLine(line: string): string {
  const length = line.length;
  for (let unitLength = 1; unitLength <= length / 2; unitLength++) {
    if (length % unitLength !== 0) continue;
    const unit = line.slice(0, unitLength);
    let isRepeated = true;
    for (let offset = unitLength; offset < length; offset += unitLength) {
      if (line.slice(offset, offset + unitLength) !== unit) {
        isRepeated = false;
        break;
      }
    }
    if (isRepeated) return unit;
  }
  return line;
}

/** Applies {@link collapseRepeatedLine} to every line of a (possibly multi-line) text. */
export function collapseRepeatedRuns(text: string): string {
  return text
    .split('\n')
    .map(collapseRepeatedLine)
    .join('\n');
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export async function extractPdfText(path: string): Promise<PdfText> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(
        `No PDF at "${path}". Coverage documents are not fetchable from the ` +
          `Medicare Coverage Database — place the "Create PDF" export there and re-run.`,
      );
    }
    throw error;
  }

  const pdf = await getDocumentProxy(bytes);
  const { text: rawPages, totalPages } = await extractText(pdf);
  const pages = rawPages.map(collapseRepeatedRuns);
  return { pages, text: pages.join('\n'), totalPages };
}
