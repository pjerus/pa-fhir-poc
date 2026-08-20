#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { extractLcd } from './src/extract/extract.ts';
import { createOllamaClient } from './src/extract/llm-client.ts';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_EXTRACTION_MODEL = 'qwen3.8:27b';
const FIXTURES_DIR = 'fixtures';

const USAGE = `Usage:
  node cli.ts extract <path-to-lcd.pdf>   Extract requirements and snapshot them

Environment:
  OLLAMA_URL         default ${DEFAULT_OLLAMA_URL}
  EXTRACTION_MODEL   default ${DEFAULT_EXTRACTION_MODEL}`;

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

const [verb, ...rest] = process.argv.slice(2);

try {
  switch (verb) {
    case 'extract':
      await runExtract(rest);
      break;
    default:
      throw new Error(verb === undefined ? USAGE : `Unknown command "${verb}".\n\n${USAGE}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
