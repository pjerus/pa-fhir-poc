#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { extractLcd } from './src/extract/extract.ts';
import type { ExtractionResult } from './src/extract/extract.ts';
import { createOllamaClient } from './src/extract/llm-client.ts';
import { loadGraphConfig } from './src/graph/config.ts';
import { createGraph } from './src/graph/db.ts';
import { ensureConstraints } from './src/graph/schema.ts';
import { loadSubgraph } from './src/graph/write.ts';
import { validateGraph } from './src/graph/validate.ts';
import type { ArticleInput, LcdInput } from './src/types.ts';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_EXTRACTION_MODEL = 'qwen3.8:27b';
const FIXTURES_DIR = 'fixtures';

const USAGE = `Usage:
  node cli.ts extract <path-to-lcd.pdf>         Extract requirements and snapshot them
  node cli.ts load <lcdId> [articleId]          Load a snapshot into the graph and validate it

Environment:
  OLLAMA_URL         default ${DEFAULT_OLLAMA_URL}
  EXTRACTION_MODEL   default ${DEFAULT_EXTRACTION_MODEL}
  NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, NEO4J_DATABASE   see .env.example`;

async function runExtract(args: readonly string[]): Promise<void> {
  const pdfPath = args[0];
  if (pdfPath === undefined) throw new Error(`extract needs a PDF path.\n\n${USAGE}`);

  const llm = createOllamaClient({
    baseUrl: process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    model: process.env.EXTRACTION_MODEL ?? DEFAULT_EXTRACTION_MODEL,
  });

  const result = await extractLcd(pdfPath, llm);

  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);

  await mkdir(FIXTURES_DIR, { recursive: true });
  const snapshotPath = join(FIXTURES_DIR, `${result.lcdId}.extracted.json`);
  await writeFile(snapshotPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stderr.write(`snapshot: ${snapshotPath}\n`);

  process.stdout.write(`${JSON.stringify(result.requirements, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readExtractedSnapshot(lcdId: string): Promise<ExtractionResult> {
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
    !Array.isArray(parsed.requirements)
  ) {
    throw new Error(`Malformed extraction snapshot at ${path}: expected lcdId, sourceHash, and requirements.`);
  }
  return parsed as unknown as ExtractionResult;
}

async function readArticleSnapshot(articleId: string): Promise<ArticleInput> {
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
  return parsed as unknown as ArticleInput;
}

async function runLoad(args: readonly string[]): Promise<void> {
  const [lcdId, articleId] = args;
  if (lcdId === undefined) throw new Error(`load needs an LCD id.\n\n${USAGE}`);

  const snapshot = await readExtractedSnapshot(lcdId);
  const lcd: LcdInput = {
    id: snapshot.lcdId,
    sourceHash: snapshot.sourceHash,
    requirements: snapshot.requirements,
    // TODO(HCPCS extraction): a later milestone extracts the LCD's covered
    // codes; until then every LCD loads with no COVERS edges.
    coveredCodes: [],
  };
  const article = articleId === undefined ? undefined : await readArticleSnapshot(articleId);

  const graph = createGraph(loadGraphConfig());
  try {
    await ensureConstraints(graph);
    await loadSubgraph(graph, article === undefined ? { lcd } : { lcd, article });
    const report = await validateGraph(graph);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.clean) process.exitCode = 1;
  } finally {
    await graph.close();
  }
}

const [verb, ...rest] = process.argv.slice(2);

try {
  switch (verb) {
    case 'extract':
      await runExtract(rest);
      break;
    case 'load':
      await runLoad(rest);
      break;
    default:
      throw new Error(verb === undefined ? USAGE : `Unknown command "${verb}".\n\n${USAGE}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
