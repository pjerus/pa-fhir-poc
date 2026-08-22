import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ArticleExtractionResult } from './article.ts';
import { extractArticle } from './article.ts';
import type { ExtractionResult } from './extract.ts';
import { extractLcd } from './extract.ts';
import type { LlmClient } from './llm-client.ts';
import type { ArticleInput, CodeRef } from '../types.ts';

// Deliberately cwd-relative, matching the CLI's original behavior — the test
// suites isolate runs by spawning from a temp cwd with its own fixtures/.
export const FIXTURES_DIR = 'fixtures';

/** Coverage facts split unpredictably between an LCD and its article; COVERS is their union. */
export function unionCodes(first: readonly CodeRef[], second: readonly CodeRef[]): CodeRef[] {
  const seen = new Set<string>();
  const out: CodeRef[] = [];
  for (const code of [...first, ...second]) {
    const key = `${code.system}|${code.code}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(code);
    }
  }
  return out;
}

export async function extractAndSnapshot(pdfPath: string, llm: LlmClient): Promise<ExtractionResult> {
  const result = await extractLcd(pdfPath, llm);

  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);

  await mkdir(FIXTURES_DIR, { recursive: true });
  const snapshotPath = join(FIXTURES_DIR, `${result.lcdId}.extracted.json`);
  await writeFile(snapshotPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stderr.write(`snapshot: ${snapshotPath}\n`);

  return result;
}

export async function extractArticleAndSnapshot(pdfPath: string, llm: LlmClient): Promise<ArticleExtractionResult> {
  const result = await extractArticle(pdfPath, llm);

  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);

  const { warnings, ...snapshot } = result;

  await mkdir(FIXTURES_DIR, { recursive: true });
  const snapshotPath = join(FIXTURES_DIR, `${result.id}.article.json`);
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  process.stderr.write(`snapshot: ${snapshotPath}\n`);

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function readExtractedSnapshot(lcdId: string): Promise<ExtractionResult> {
  const path = join(FIXTURES_DIR, `${lcdId}.extracted.json`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No extraction snapshot at ${path}. Run: node cli.ts extract <path-to-lcd.pdf>`);
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.lcdId !== 'string' ||
    typeof parsed.sourceHash !== 'string' ||
    !Array.isArray(parsed.requirements) ||
    !Array.isArray(parsed.hcpcsCodes)
  ) {
    throw new Error(
      `Malformed extraction snapshot at ${path}: expected lcdId, sourceHash, requirements, and ` +
        'hcpcsCodes. A snapshot from an older pipeline lacks hcpcsCodes; re-run: node cli.ts extract <path-to-lcd.pdf>',
    );
  }
  return parsed as unknown as ExtractionResult;
}

interface ArticleSnapshotFile {
  readonly article: ArticleInput;
  /** HCPCS codes, when the snapshot has them (the article extractor's output). */
  readonly hcpcsCodes: readonly CodeRef[];
}

export async function readArticleSnapshot(articleId: string): Promise<ArticleSnapshotFile> {
  const path = join(FIXTURES_DIR, `${articleId}.article.json`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No article snapshot at ${path}. The article extractor that produces this file is a later milestone; author it by hand for now.`,
      );
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.id !== 'string' ||
    typeof parsed.sourceHash !== 'string' ||
    !Array.isArray(parsed.listedCodes) ||
    !Array.isArray(parsed.denialReasons)
  ) {
    throw new Error(
      `Malformed article snapshot at ${path}: expected id, sourceHash, listedCodes, and denialReasons.`,
    );
  }
  const hcpcsCodes = Array.isArray(parsed.hcpcsCodes) ? (parsed.hcpcsCodes as CodeRef[]) : [];
  return { article: parsed as unknown as ArticleInput, hcpcsCodes };
}
