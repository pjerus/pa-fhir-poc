#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { extractArticle } from './src/extract/article.ts';
import type { ArticleExtractionResult } from './src/extract/article.ts';
import { extractLcd } from './src/extract/extract.ts';
import type { ExtractionResult } from './src/extract/extract.ts';
import { createOllamaClient } from './src/extract/llm-client.ts';
import { loadGraphConfig } from './src/graph/config.ts';
import { createGraph } from './src/graph/db.ts';
import { readApprovedSubgraph } from './src/graph/read.ts';
import { ensureConstraints } from './src/graph/schema.ts';
import { loadSubgraph } from './src/graph/write.ts';
import { validateGraph } from './src/graph/validate.ts';
import { projectLcd } from './src/fhir/project.ts';
import { awaitReview, signalReview, startReview } from './src/workflow/client.ts';
import type { ArticleInput, CodeRef, LcdInput, ReviewDecision } from './src/types.ts';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_EXTRACTION_MODEL = 'qwen3.8:27b';
const FIXTURES_DIR = 'fixtures';
const OUT_DIR = 'out';

const USAGE = `Usage:
  node cli.ts extract <path-to-lcd.pdf>                        Extract requirements and snapshot them
  node cli.ts extract-article <path-to-article.pdf>            Extract ICD-10/HCPCS codes and denial reasons, and snapshot them
  node cli.ts load <lcdId> [articleId]                         Load a snapshot into the graph and validate it
  node cli.ts review-start <lcdId> [articleId]                 Start the review workflow for a snapshot
  node cli.ts review-signal <workflowId> <approve|reject> <reviewer> [note]
                                                                Deliver a human review decision to a running workflow
  node cli.ts project <lcdId>                                  Project an approved LCD to CRD/DTR/PlanDefinition FHIR artifacts
  node cli.ts run <lcd.pdf> <article.pdf>                      Extract both, start review, block for a human signal, then project on approval

Environment:
  OLLAMA_URL         default ${DEFAULT_OLLAMA_URL}
  EXTRACTION_MODEL   default ${DEFAULT_EXTRACTION_MODEL}
  NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, NEO4J_DATABASE   see .env.example
  TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_TASK_QUEUE   see .env.example`;

function ollamaClient(): ReturnType<typeof createOllamaClient> {
  return createOllamaClient({
    baseUrl: process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    model: process.env.EXTRACTION_MODEL ?? DEFAULT_EXTRACTION_MODEL,
  });
}

async function extractAndSnapshot(pdfPath: string): Promise<ExtractionResult> {
  const result = await extractLcd(pdfPath, ollamaClient());

  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);

  await mkdir(FIXTURES_DIR, { recursive: true });
  const snapshotPath = join(FIXTURES_DIR, `${result.lcdId}.extracted.json`);
  await writeFile(snapshotPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stderr.write(`snapshot: ${snapshotPath}\n`);

  return result;
}

async function runExtract(args: readonly string[]): Promise<void> {
  const pdfPath = args[0];
  if (pdfPath === undefined) throw new Error(`extract needs a PDF path.\n\n${USAGE}`);

  const result = await extractAndSnapshot(pdfPath);
  process.stdout.write(`${JSON.stringify(result.requirements, null, 2)}\n`);
}

async function extractArticleAndSnapshot(pdfPath: string): Promise<ArticleExtractionResult> {
  const result = await extractArticle(pdfPath, ollamaClient());

  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);

  const { warnings, ...snapshot } = result;

  await mkdir(FIXTURES_DIR, { recursive: true });
  const snapshotPath = join(FIXTURES_DIR, `${result.id}.article.json`);
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  process.stderr.write(`snapshot: ${snapshotPath}\n`);

  return result;
}

async function runExtractArticle(args: readonly string[]): Promise<void> {
  const pdfPath = args[0];
  if (pdfPath === undefined) throw new Error(`extract-article needs a PDF path.\n\n${USAGE}`);

  const result = await extractArticleAndSnapshot(pdfPath);
  const { warnings, ...snapshot } = result;
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
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

interface ArticleSnapshot {
  readonly article: ArticleInput;
  /** HCPCS codes, when the snapshot has them (the article extractor's output). */
  readonly hcpcsCodes: readonly CodeRef[];
}

async function readArticleSnapshot(articleId: string): Promise<ArticleSnapshot> {
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

async function runLoad(args: readonly string[]): Promise<void> {
  const [lcdId, articleId] = args;
  if (lcdId === undefined) throw new Error(`load needs an LCD id.\n\n${USAGE}`);

  const snapshot = await readExtractedSnapshot(lcdId);
  const articleSnapshot = articleId === undefined ? undefined : await readArticleSnapshot(articleId);
  const lcd: LcdInput = {
    id: snapshot.lcdId,
    sourceHash: snapshot.sourceHash,
    requirements: snapshot.requirements,
    // Covered codes flow from the paired article's HCPCS listing; an LCD
    // loaded without an article has none.
    coveredCodes: articleSnapshot?.hcpcsCodes ?? [],
  };

  const graph = createGraph(loadGraphConfig());
  try {
    await ensureConstraints(graph);
    await loadSubgraph(graph, articleSnapshot === undefined ? { lcd } : { lcd, article: articleSnapshot.article });
    const report = await validateGraph(graph);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.clean) process.exitCode = 1;
  } finally {
    await graph.close();
  }
}

async function runReviewStart(args: readonly string[]): Promise<void> {
  const [lcdId, articleId] = args;
  if (lcdId === undefined) throw new Error(`review-start needs an LCD id.\n\n${USAGE}`);

  const snapshot = await readExtractedSnapshot(lcdId);
  const articleSnapshot = articleId === undefined ? undefined : await readArticleSnapshot(articleId);
  const lcd: LcdInput = {
    id: snapshot.lcdId,
    sourceHash: snapshot.sourceHash,
    requirements: snapshot.requirements,
    // Covered codes flow from the paired article's HCPCS listing; an LCD
    // loaded without an article has none.
    coveredCodes: articleSnapshot?.hcpcsCodes ?? [],
  };

  const workflowId = await startReview(
    articleSnapshot === undefined ? { lcd } : { lcd, article: articleSnapshot.article },
  );
  process.stdout.write(`${workflowId}\n`);
  process.stderr.write(
    `Run a worker to process this review: node src/workflow/worker.ts\n` +
      `Send the review decision: node cli.ts review-signal ${workflowId} <approve|reject> <reviewer> [note]\n`,
  );
}

async function projectAndWrite(lcdId: string): Promise<void> {
  const graph = createGraph(loadGraphConfig());
  try {
    const subgraph = await readApprovedSubgraph(graph, lcdId);
    const { crd, dtr, planDefinition } = projectLcd(subgraph);

    await mkdir(OUT_DIR, { recursive: true });
    const paths = {
      crd: join(OUT_DIR, `${lcdId}.crd.json`),
      dtr: join(OUT_DIR, `${lcdId}.dtr.json`),
      planDefinition: join(OUT_DIR, `${lcdId}.plandefinition.json`),
    };
    await writeFile(paths.crd, `${JSON.stringify(crd, null, 2)}\n`, 'utf8');
    await writeFile(paths.dtr, `${JSON.stringify(dtr, null, 2)}\n`, 'utf8');
    await writeFile(paths.planDefinition, `${JSON.stringify(planDefinition, null, 2)}\n`, 'utf8');

    process.stdout.write(`${paths.crd}\n${paths.dtr}\n${paths.planDefinition}\n`);
  } finally {
    await graph.close();
  }
}

async function runProject(args: readonly string[]): Promise<void> {
  const [lcdId] = args;
  if (lcdId === undefined) throw new Error(`project needs an LCD id.\n\n${USAGE}`);

  await projectAndWrite(lcdId);
}

async function assertFileExists(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
}

async function runRun(args: readonly string[]): Promise<void> {
  const [lcdPath, articlePath] = args;
  if (lcdPath === undefined || articlePath === undefined) {
    throw new Error(`run needs a path to the LCD PDF and a path to the article PDF.\n\n${USAGE}`);
  }

  await assertFileExists(lcdPath, 'LCD PDF');
  await assertFileExists(articlePath, 'Article PDF');

  const lcdResult = await extractAndSnapshot(lcdPath);
  const articleResult = await extractArticleAndSnapshot(articlePath);

  const lcd: LcdInput = {
    id: lcdResult.lcdId,
    sourceHash: lcdResult.sourceHash,
    requirements: lcdResult.requirements,
    // Covered codes flow from the paired article's HCPCS listing, same as review-start.
    coveredCodes: articleResult.hcpcsCodes,
  };
  const article: ArticleInput = articleResult;

  const workflowId = await startReview({ lcd, article });
  process.stdout.write(`${workflowId}\n`);
  process.stderr.write(
    `Run a worker to process this review: node src/workflow/worker.ts\n` +
      `Send the review decision: node cli.ts review-signal ${workflowId} <approve|reject> <reviewer> [note]\n`,
  );

  const result = await awaitReview(workflowId);
  if (result.outcome !== 'approved') {
    throw new Error(`Review rejected — ${result.lcdId} was not projected.`);
  }
  await projectAndWrite(result.lcdId);
}

async function runReviewSignal(args: readonly string[]): Promise<void> {
  const [workflowId, decisionArg, reviewer, note] = args;
  if (workflowId === undefined || decisionArg === undefined || reviewer === undefined) {
    throw new Error(`review-signal needs a workflow id, decision, and reviewer.\n\n${USAGE}`);
  }
  if (decisionArg !== 'approve' && decisionArg !== 'reject') {
    throw new Error(`review-signal decision must be "approve" or "reject", got "${decisionArg}".\n\n${USAGE}`);
  }

  const decision: ReviewDecision = note === undefined ? { decision: decisionArg, reviewer } : { decision: decisionArg, reviewer, note };
  await signalReview(workflowId, decision);
  process.stdout.write(`Signaled ${workflowId}: ${decisionArg}\n`);
}

const [verb, ...rest] = process.argv.slice(2);

try {
  switch (verb) {
    case 'extract':
      await runExtract(rest);
      break;
    case 'extract-article':
      await runExtractArticle(rest);
      break;
    case 'load':
      await runLoad(rest);
      break;
    case 'review-start':
      await runReviewStart(rest);
      break;
    case 'review-signal':
      await runReviewSignal(rest);
      break;
    case 'project':
      await runProject(rest);
      break;
    case 'run':
      await runRun(rest);
      break;
    default:
      throw new Error(verb === undefined ? USAGE : `Unknown command "${verb}".\n\n${USAGE}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
