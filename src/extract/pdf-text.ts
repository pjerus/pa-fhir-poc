import { readFile } from 'node:fs/promises';

import { extractText, getDocumentProxy } from 'unpdf';

export interface PdfText {
  /** Every page concatenated, one page per entry. */
  readonly pages: readonly string[];
  /** All pages merged into a single string. */
  readonly text: string;
  readonly totalPages: number;
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
  const { text: pages, totalPages } = await extractText(pdf);
  return { pages, text: pages.join('\n'), totalPages };
}
