import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';

import type { Graph } from '../graph/db.ts';
import { createGraph } from '../graph/db.ts';
import { loadGraphConfig } from '../graph/config.ts';
import { readSubgraph } from '../graph/read.ts';

import { lcdIdFromPath } from '../extract/extract.ts';
import { extractAndSnapshot, extractArticleAndSnapshot, FIXTURES_DIR, unionCodes } from '../extract/snapshot.ts';
import { createOllamaClient } from '../extract/llm-client.ts';
import type { LlmClient } from '../extract/llm-client.ts';

import { projectAndWrite } from '../fhir/write.ts';

import {
  describeReview,
  getReviewResult,
  listReviewWorkflows,
  queryReviewStatus,
  signalReview,
  startReview,
} from '../workflow/client.ts';
import type { ReviewWorkflowInfo } from '../workflow/client.ts';
import type { ReviewResult } from '../workflow/review.workflow.ts';

import { JobStore } from './jobs.ts';
import { mergeStatus } from './status.ts';
import type { WorkflowSnapshot } from './status.ts';

import type { ArticleInput, LcdInput, ReviewDecision } from '../types.ts';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_EXTRACTION_MODEL = 'qwen3.8:27b';
const DEFAULT_UI_PORT = 8006;

/** Client-filename-derived ids, and lcd/article ids in URLs, must look like this. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVIEW_WORKFLOW_ID = /^review-[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Every side-effecting function the routes need, bundled so tests can supply
 * fakes instead of a live Ollama/Temporal/Neo4j. `node src/ui/server.ts`
 * wires the real ones; `createHandlers` never imports them directly.
 */
export interface ServerDeps {
  readonly extractAndSnapshot: typeof extractAndSnapshot;
  readonly extractArticleAndSnapshot: typeof extractArticleAndSnapshot;
  readonly startReview: typeof startReview;
  readonly signalReview: typeof signalReview;
  readonly listReviewWorkflows: typeof listReviewWorkflows;
  readonly describeReview: typeof describeReview;
  readonly queryReviewStatus: typeof queryReviewStatus;
  readonly getReviewResult: typeof getReviewResult;
  readonly projectAndWrite: typeof projectAndWrite;
  readonly readSubgraph: typeof readSubgraph;
  readonly createGraph: () => Graph;
  readonly llm: LlmClient;
  readonly jobs: JobStore;
}

export interface HandlerResult {
  readonly status: number;
  readonly body: unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The chain a successful upload runs through, unawaited by the route handler that fires it. */
async function runChain(deps: ServerDeps, jobId: string, lcdPdfPath: string, articlePdfPath: string): Promise<void> {
  try {
    const lcdResult = await deps.extractAndSnapshot(lcdPdfPath, deps.llm);
    const articleResult = await deps.extractArticleAndSnapshot(articlePdfPath, deps.llm);

    deps.jobs.markStartingReview(jobId);

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

    let workflowId: string;
    try {
      workflowId = await deps.startReview({ lcd, article });
    } catch (err) {
      // Idempotent startReview: an already-running workflow for this lcdId is
      // success, not failure — Temporal's own dedup primitive, not reimplemented.
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        workflowId = `review-${lcd.id}`;
      } else {
        throw err;
      }
    }

    deps.jobs.markAttached(jobId, workflowId);
  } catch (err) {
    deps.jobs.markFailed(jobId, String(err));
  }
}

function parseSignalBody(value: unknown): ReviewDecision | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { decision, reviewer, note } = value as Record<string, unknown>;
  if (decision !== 'approve' && decision !== 'reject') return undefined;
  if (typeof reviewer !== 'string' || reviewer.trim() === '') return undefined;
  if (note !== undefined && typeof note !== 'string') return undefined;
  return note === undefined ? { decision, reviewer } : { decision, reviewer, note };
}

export function createHandlers(deps: ServerDeps): {
  getRuns(): Promise<HandlerResult>;
  postRuns(formData: FormData): Promise<HandlerResult>;
  getReview(workflowId: string): Promise<HandlerResult>;
  postSignal(workflowId: string, body: unknown): Promise<HandlerResult>;
  postProject(lcdId: string): Promise<HandlerResult>;
} {
  // Outcomes are immutable once a workflow COMPLETEs, so a result fetched
  // once for /api/runs polling is cached rather than re-fetched every poll.
  const outcomeCache = new Map<string, ReviewResult>();

  async function snapshotWorkflows(): Promise<WorkflowSnapshot[]> {
    const infos = await deps.listReviewWorkflows();
    return Promise.all(infos.map((info) => toSnapshot(info)));
  }

  async function toSnapshot(info: ReviewWorkflowInfo): Promise<WorkflowSnapshot> {
    if (info.status === 'RUNNING') {
      const reviewStatus = await deps.queryReviewStatus(info.workflowId);
      return { workflowId: info.workflowId, status: info.status, reviewStatus };
    }
    if (info.status === 'COMPLETED') {
      let result = outcomeCache.get(info.workflowId);
      if (result === undefined) {
        result = await deps.getReviewResult(info.workflowId);
        outcomeCache.set(info.workflowId, result);
      }
      return { workflowId: info.workflowId, status: info.status, outcome: result.outcome };
    }
    // FAILED, CANCELLED, TERMINATED, CONTINUED_AS_NEW, TIMED_OUT: the status
    // name itself is the POC-sufficient failure reason (per the plan).
    return { workflowId: info.workflowId, status: info.status, failureReason: info.status };
  }

  async function getRuns(): Promise<HandlerResult> {
    const workflows = await snapshotWorkflows();
    return { status: 200, body: mergeStatus(deps.jobs.list(), workflows) };
  }

  async function postRuns(formData: FormData): Promise<HandlerResult> {
    const lcdFile = formData.get('lcdPdf');
    const articleFile = formData.get('articlePdf');
    if (!(lcdFile instanceof File) || !(articleFile instanceof File)) {
      return { status: 400, body: { error: 'multipart form must include lcdPdf and articlePdf files' } };
    }

    const lcdId = lcdIdFromPath(lcdFile.name);
    const articleId = lcdIdFromPath(articleFile.name);
    if (!SAFE_ID.test(lcdId) || !SAFE_ID.test(articleId)) {
      return {
        status: 400,
        body: { error: `filenames must derive a safe id; got lcd="${lcdId}" article="${articleId}"` },
      };
    }

    // Idempotent submit: a non-terminal job for this lcdId already means a
    // chain is in flight — attach the caller to it instead of starting a
    // second one. JobStore.create() itself already returns that existing
    // job; the pre-check here is only to skip re-writing files / re-firing
    // the chain for it.
    const alreadyInFlight = deps.jobs
      .list()
      .some((job) => job.lcdId === lcdId && (job.status === 'extracting' || job.status === 'starting-review'));
    const job = deps.jobs.create(lcdId, articleId, () => new Date().toISOString());
    if (alreadyInFlight) {
      return { status: 202, body: { jobId: job.id } };
    }

    await mkdir(FIXTURES_DIR, { recursive: true });
    const lcdPath = join(FIXTURES_DIR, `${lcdId}.pdf`);
    const articlePath = join(FIXTURES_DIR, `${articleId}.pdf`);
    await writeFile(lcdPath, Buffer.from(await lcdFile.arrayBuffer()));
    await writeFile(articlePath, Buffer.from(await articleFile.arrayBuffer()));

    void runChain(deps, job.id, lcdPath, articlePath);

    return { status: 202, body: { jobId: job.id } };
  }

  async function getReview(workflowId: string): Promise<HandlerResult> {
    if (!REVIEW_WORKFLOW_ID.test(workflowId)) {
      return { status: 400, body: { error: `invalid workflow id: "${workflowId}"` } };
    }
    const lcdId = workflowId.slice('review-'.length);
    const graph = deps.createGraph();
    try {
      const subgraph = await deps.readSubgraph(graph, lcdId);
      return { status: 200, body: subgraph };
    } catch (err) {
      if (/not found in the graph/.test(errorMessage(err))) {
        return { status: 404, body: { error: errorMessage(err) } };
      }
      throw err;
    } finally {
      await graph.close();
    }
  }

  async function postSignal(workflowId: string, body: unknown): Promise<HandlerResult> {
    const decision = parseSignalBody(body);
    if (decision === undefined) {
      return {
        status: 400,
        body: { error: 'body must be {decision: "approve"|"reject", reviewer: non-empty string, note?: string}' },
      };
    }

    try {
      await deps.signalReview(workflowId, decision);
      return { status: 200, body: { ok: true } };
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError)) throw err;

      let info: ReviewWorkflowInfo;
      try {
        info = await deps.describeReview(workflowId);
      } catch {
        return { status: 404, body: { error: 'no such pending review' } };
      }
      if (info.status !== 'RUNNING') {
        return { status: 409, body: { error: 'this review was already decided' } };
      }
      // signalReview said not-found but describe says RUNNING: contradiction, not a mapped case.
      throw err;
    }
  }

  async function postProject(lcdId: string): Promise<HandlerResult> {
    if (!SAFE_ID.test(lcdId)) {
      return { status: 400, body: { error: `invalid lcd id: "${lcdId}"` } };
    }
    try {
      const result = await deps.projectAndWrite(lcdId);
      return { status: 200, body: result };
    } catch (err) {
      if (/is not approved/.test(errorMessage(err))) {
        return { status: 409, body: { error: errorMessage(err) } };
      }
      throw err;
    }
  }

  return { getRuns, postRuns, getReview, postSignal, postProject };
}

// --- Real entrypoint: `node src/ui/server.ts` (not run when this module is only imported, e.g. by tests). ---

function ollamaClient(): LlmClient {
  return createOllamaClient({
    baseUrl: process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    model: process.env.EXTRACTION_MODEL ?? DEFAULT_EXTRACTION_MODEL,
  });
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function respond(res: ServerResponse, result: HandlerResult): void {
  res.writeHead(result.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result.body));
}

const REVIEW_ROUTE = /^\/api\/reviews\/([^/]+)$/;
const SIGNAL_ROUTE = /^\/api\/reviews\/([^/]+)\/signal$/;
const PROJECT_ROUTE = /^\/api\/lcds\/([^/]+)\/project$/;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const indexHtml = await readFile(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');

  const deps: ServerDeps = {
    extractAndSnapshot,
    extractArticleAndSnapshot,
    startReview,
    signalReview,
    listReviewWorkflows,
    describeReview,
    queryReviewStatus,
    getReviewResult,
    projectAndWrite,
    readSubgraph,
    createGraph: () => createGraph(loadGraphConfig()),
    llm: ollamaClient(),
    jobs: new JobStore(),
  };
  const handlers = createHandlers(deps);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const { pathname } = url;

        if (req.method === 'GET' && pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(indexHtml);
          return;
        }

        if (req.method === 'GET' && pathname === '/api/runs') {
          respond(res, await handlers.getRuns());
          return;
        }

        if (req.method === 'POST' && pathname === '/api/runs') {
          const contentType = req.headers['content-type'];
          if (contentType === undefined) {
            respond(res, { status: 400, body: { error: 'missing content-type' } });
            return;
          }
          const form = await new Response(req, { headers: { 'content-type': contentType } }).formData();
          respond(res, await handlers.postRuns(form));
          return;
        }

        const signalMatch = pathname.match(SIGNAL_ROUTE);
        if (req.method === 'POST' && signalMatch) {
          const raw = await readRequestBody(req);
          let body: unknown;
          try {
            body = raw === '' ? {} : JSON.parse(raw);
          } catch {
            respond(res, { status: 400, body: { error: 'invalid JSON body' } });
            return;
          }
          respond(res, await handlers.postSignal(decodeURIComponent(signalMatch[1]!), body));
          return;
        }

        const reviewMatch = pathname.match(REVIEW_ROUTE);
        if (req.method === 'GET' && reviewMatch) {
          respond(res, await handlers.getReview(decodeURIComponent(reviewMatch[1]!)));
          return;
        }

        const projectMatch = pathname.match(PROJECT_ROUTE);
        if (req.method === 'POST' && projectMatch) {
          respond(res, await handlers.postProject(decodeURIComponent(projectMatch[1]!)));
          return;
        }

        respond(res, { status: 404, body: { error: `no route for ${req.method} ${pathname}` } });
      } catch (err) {
        respond(res, { status: 500, body: { error: errorMessage(err) } });
      }
    })();
  });

  const port = Number(process.env.UI_PORT ?? DEFAULT_UI_PORT);
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`review console listening on http://127.0.0.1:${port} (run from repo root)\n`);
  });
}
