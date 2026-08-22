#!/usr/bin/env node
import { access } from 'node:fs/promises';

import { createOllamaClient } from './src/extract/llm-client.ts';
import {
  extractAndSnapshot,
  extractArticleAndSnapshot,
  readArticleSnapshot,
  readExtractedSnapshot,
  unionCodes,
} from './src/extract/snapshot.ts';
import { loadGraphConfig } from './src/graph/config.ts';
import { createGraph } from './src/graph/db.ts';
import { ensureConstraints } from './src/graph/schema.ts';
import { loadSubgraph } from './src/graph/write.ts';
import { validateGraph } from './src/graph/validate.ts';
import { OUT_DIR, projectAndWrite } from './src/fhir/write.ts';
import { validateProjection } from './src/fhir/validate.ts';
import { awaitReview, signalReview, startReview } from './src/workflow/client.ts';
import type { ArticleInput, LcdInput, ReviewDecision } from './src/types.ts';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_EXTRACTION_MODEL = 'qwen3.8:27b';

const USAGE = `Usage:
  node cli.ts extract <path-to-lcd.pdf>                        Extract requirements and snapshot them
  node cli.ts extract-article <path-to-article.pdf>            Extract ICD-10/HCPCS codes and denial reasons, and snapshot them
  node cli.ts load <lcdId> [articleId]                         Load a snapshot into the graph and validate it
  node cli.ts review-start <lcdId> [articleId]                 Start the review workflow for a snapshot
  node cli.ts review-signal <workflowId> <approve|reject> <reviewer> [note]
                                                                Deliver a human review decision to a running workflow
  node cli.ts project <lcdId>                                  Project an approved LCD to CRD/DTR/PlanDefinition FHIR artifacts
  node cli.ts validate <lcdId>                                 Validate projected artifacts with the official HL7 validator (Docker; run tools/fetch-validator.sh once first)
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

async function runExtract(args: readonly string[]): Promise<void> {
  const pdfPath = args[0];
  if (pdfPath === undefined) throw new Error(`extract needs a PDF path.\n\n${USAGE}`);

  const result = await extractAndSnapshot(pdfPath, ollamaClient());
  process.stdout.write(`${JSON.stringify(result.requirements, null, 2)}\n`);
}

async function runExtractArticle(args: readonly string[]): Promise<void> {
  const pdfPath = args[0];
  if (pdfPath === undefined) throw new Error(`extract-article needs a PDF path.\n\n${USAGE}`);

  const result = await extractArticleAndSnapshot(pdfPath, ollamaClient());
  const { warnings, ...snapshot } = result;
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
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
    coveredCodes: unionCodes(snapshot.hcpcsCodes, articleSnapshot?.hcpcsCodes ?? []),
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
    coveredCodes: unionCodes(snapshot.hcpcsCodes, articleSnapshot?.hcpcsCodes ?? []),
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

async function runProject(args: readonly string[]): Promise<void> {
  const [lcdId] = args;
  if (lcdId === undefined) throw new Error(`project needs an LCD id.\n\n${USAGE}`);

  const { paths } = await projectAndWrite(lcdId);
  process.stdout.write(`${paths.crd}\n${paths.dtr}\n${paths.planDefinition}\n`);
}

async function assertFileExists(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
}

async function runValidate(args: readonly string[]): Promise<void> {
  const [lcdId] = args;
  if (lcdId === undefined) throw new Error(`validate needs an LCD id.\n\n${USAGE}`);

  const results = await validateProjection(lcdId, OUT_DIR);

  process.stdout.write('\n');
  for (const { run, exitCode } of results) {
    process.stdout.write(`${exitCode === 0 ? 'PASS' : `FAIL (exit ${exitCode})`}  ${run.artifactFile} — ${run.label}\n`);
  }
  process.stdout.write(
    `SKIP  ${lcdId}.crd.json — CRD card is a CDS Hooks logical model under CRD v2.2.1, not a FHIR resource instance; no StructureDefinition applies.\n`,
  );
  if (results.some(({ exitCode }) => exitCode !== 0)) process.exitCode = 1;
}

async function runRun(args: readonly string[]): Promise<void> {
  const [lcdPath, articlePath] = args;
  if (lcdPath === undefined || articlePath === undefined) {
    throw new Error(`run needs a path to the LCD PDF and a path to the article PDF.\n\n${USAGE}`);
  }

  await assertFileExists(lcdPath, 'LCD PDF');
  await assertFileExists(articlePath, 'Article PDF');

  const lcdResult = await extractAndSnapshot(lcdPath, ollamaClient());
  const articleResult = await extractArticleAndSnapshot(articlePath, ollamaClient());

  const lcd: LcdInput = {
    id: lcdResult.lcdId,
    sourceHash: lcdResult.sourceHash,
    requirements: lcdResult.requirements,
    coveredCodes: unionCodes(lcdResult.hcpcsCodes, articleResult.hcpcsCodes),
  };
  const article: ArticleInput = {
    id: articleResult.id,
    sourceHash: articleResult.sourceHash,
    listedCodes: articleResult.listedCodes,
    denialReasons: articleResult.denialReasons,
  };

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
  const { paths } = await projectAndWrite(result.lcdId);
  process.stdout.write(`${paths.crd}\n${paths.dtr}\n${paths.planDefinition}\n`);
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
    case 'validate':
      await runValidate(rest);
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
