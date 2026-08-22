import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';

import { createHandlers } from './server.ts';
import type { ServerDeps } from './server.ts';
import { JobStore } from './jobs.ts';
import { FIXTURES_DIR } from '../extract/snapshot.ts';
import type { ExtractionResult } from '../extract/extract.ts';
import type { ArticleExtractionResult } from '../extract/article.ts';
import type { ApprovedSubgraph } from '../graph/read.ts';
import type { Graph } from '../graph/db.ts';
import type { ReviewWorkflowInfo } from '../workflow/client.ts';

// Route handlers only — every dep is a fake; no live Ollama/Temporal/Neo4j.
// `postRuns` fires its extraction chain unawaited (matches the real server's
// contract), so tests that exercise the chain poll job state instead of
// awaiting `postRuns` itself for the outcome, the same pattern
// review.workflow.test.ts uses for workflow state transitions.

function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function extractionResult(lcdId: string): ExtractionResult {
  return {
    lcdId,
    dialect: 'mac',
    sourceHash: `hash-${lcdId}`,
    requirements: [{ id: `${lcdId}-R1`, text: 'req one', ordinal: 1, category: 'indication' }],
    hcpcsCodes: [{ system: 'HCPCS', code: 'E0100' }],
    warnings: [],
  };
}

function articleResult(articleId: string): ArticleExtractionResult {
  return {
    id: articleId,
    sourceHash: `hash-${articleId}`,
    listedCodes: [{ system: 'ICD10', code: 'A00.0' }],
    denialReasons: [{ id: `${articleId}-D1`, text: 'denial one' }],
    hcpcsCodes: [],
    warnings: [],
  };
}

function fakeGraph(): Graph & { closed: boolean } {
  const graph = {
    closed: false,
    async run(): Promise<Record<string, unknown>[]> {
      return [];
    },
    async close(): Promise<void> {
      graph.closed = true;
    },
  };
  return graph;
}

function baseDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    extractAndSnapshot: async () => {
      throw new Error('extractAndSnapshot not stubbed');
    },
    extractArticleAndSnapshot: async () => {
      throw new Error('extractArticleAndSnapshot not stubbed');
    },
    startReview: async () => {
      throw new Error('startReview not stubbed');
    },
    signalReview: async () => {
      throw new Error('signalReview not stubbed');
    },
    listReviewWorkflows: async () => [],
    describeReview: async () => {
      throw new Error('describeReview not stubbed');
    },
    queryReviewStatus: async () => 'awaiting-review',
    getReviewResult: async () => {
      throw new Error('getReviewResult not stubbed');
    },
    projectAndWrite: async () => {
      throw new Error('projectAndWrite not stubbed');
    },
    readSubgraph: async () => {
      throw new Error('readSubgraph not stubbed');
    },
    createGraph: () => fakeGraph(),
    llm: { complete: async () => '' },
    jobs: new JobStore(),
    ...overrides,
  };
}

function pdfFile(name: string): File {
  return new File([Buffer.from('fake pdf bytes')], name, { type: 'application/pdf' });
}

function uploadForm(lcdName: string, articleName?: string): FormData {
  const form = new FormData();
  form.set('lcdPdf', pdfFile(lcdName));
  if (articleName !== undefined) form.set('articlePdf', pdfFile(articleName));
  return form;
}

// Real fs writes land in the repo's cwd-relative fixtures/ dir (same
// assumption as the CLI); TEST- prefixed names keep them out of the way of
// real fixtures, and this cleans them up regardless of which test wrote them.
const writtenFixturePaths: string[] = [];
after(async () => {
  for (const path of writtenFixturePaths) {
    if (existsSync(path)) await rm(path);
  }
});

function trackUpload(lcdId: string, articleId: string): void {
  writtenFixturePaths.push(join(FIXTURES_DIR, `${lcdId}.pdf`), join(FIXTURES_DIR, `${articleId}.pdf`));
}

test('postRuns: happy path writes both PDFs, runs the chain in order, and attaches', async () => {
  const calls: string[] = [];
  const jobs = new JobStore();
  const deps = baseDeps({
    jobs,
    extractAndSnapshot: async () => {
      calls.push('extractLcd');
      return extractionResult('TEST-U-HAPPY');
    },
    extractArticleAndSnapshot: async () => {
      calls.push('extractArticle');
      return articleResult('TEST-U-HAPPY-A');
    },
    startReview: async (input) => {
      calls.push('startReview');
      return `review-${input.lcd.id}`;
    },
  });
  const handlers = createHandlers(deps);

  const result = await handlers.postRuns(uploadForm('TEST-U-HAPPY.pdf', 'TEST-U-HAPPY-A.pdf'));
  trackUpload('TEST-U-HAPPY', 'TEST-U-HAPPY-A');

  assert.equal(result.status, 202);
  const jobId = (result.body as { jobId: string }).jobId;
  assert.ok(jobId);
  assert.ok(existsSync(join(FIXTURES_DIR, 'TEST-U-HAPPY.pdf')));
  assert.ok(existsSync(join(FIXTURES_DIR, 'TEST-U-HAPPY-A.pdf')));

  await waitUntil(() => jobs.get(jobId)?.status === 'attached');
  assert.equal(jobs.get(jobId)?.workflowId, 'review-TEST-U-HAPPY');
  assert.deepEqual(calls, ['extractLcd', 'extractArticle', 'startReview']);
});

test('postRuns: an unsafe id derived from a filename → 400', async () => {
  const handlers = createHandlers(baseDeps());
  const result = await handlers.postRuns(uploadForm('bad name!.pdf', 'TEST-U-OK.pdf'));
  assert.equal(result.status, 400);
});

test('postRuns: missing articlePdf part → 400', async () => {
  const handlers = createHandlers(baseDeps());
  const result = await handlers.postRuns(uploadForm('TEST-U-ONLY.pdf'));
  assert.equal(result.status, 400);
});

test('postRuns: a duplicate submit for an in-flight lcdId returns the existing jobId without re-firing the chain', async () => {
  const jobs = new JobStore();
  let extractCalls = 0;
  let releaseExtract: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseExtract = resolve;
  });
  const deps = baseDeps({
    jobs,
    extractAndSnapshot: async () => {
      extractCalls += 1;
      await gate;
      return extractionResult('TEST-U-DUP');
    },
    extractArticleAndSnapshot: async () => articleResult('TEST-U-DUP-A'),
    startReview: async (input) => `review-${input.lcd.id}`,
  });
  const handlers = createHandlers(deps);

  const result1 = await handlers.postRuns(uploadForm('TEST-U-DUP.pdf', 'TEST-U-DUP-A.pdf'));
  trackUpload('TEST-U-DUP', 'TEST-U-DUP-A');
  const result2 = await handlers.postRuns(uploadForm('TEST-U-DUP.pdf', 'TEST-U-DUP-A.pdf'));

  assert.equal(result1.status, 202);
  assert.equal(result2.status, 202);
  assert.deepEqual(result1.body, result2.body);
  assert.equal(extractCalls, 1);

  releaseExtract?.();
  await waitUntil(() => jobs.get((result1.body as { jobId: string }).jobId)?.status === 'attached');
});

test('postRuns: extractAndSnapshot failure marks the job failed with the verbatim error', async () => {
  const jobs = new JobStore();
  const boom = new Error('lcd extraction boom');
  const deps = baseDeps({
    jobs,
    extractAndSnapshot: async () => {
      throw boom;
    },
  });
  const handlers = createHandlers(deps);
  const result = await handlers.postRuns(uploadForm('TEST-U-FAIL1.pdf', 'TEST-U-FAIL1-A.pdf'));
  trackUpload('TEST-U-FAIL1', 'TEST-U-FAIL1-A');
  const jobId = (result.body as { jobId: string }).jobId;

  await waitUntil(() => jobs.get(jobId)?.status === 'failed');
  assert.equal(jobs.get(jobId)?.error, String(boom));
});

test('postRuns: extractArticleAndSnapshot failure marks the job failed with the verbatim error', async () => {
  const jobs = new JobStore();
  const boom = new Error('article extraction boom');
  const deps = baseDeps({
    jobs,
    extractAndSnapshot: async () => extractionResult('TEST-U-FAIL2'),
    extractArticleAndSnapshot: async () => {
      throw boom;
    },
  });
  const handlers = createHandlers(deps);
  const result = await handlers.postRuns(uploadForm('TEST-U-FAIL2.pdf', 'TEST-U-FAIL2-A.pdf'));
  trackUpload('TEST-U-FAIL2', 'TEST-U-FAIL2-A');
  const jobId = (result.body as { jobId: string }).jobId;

  await waitUntil(() => jobs.get(jobId)?.status === 'failed');
  assert.equal(jobs.get(jobId)?.error, String(boom));
});

test('postRuns: a non-AlreadyStarted startReview failure marks the job failed with the verbatim error', async () => {
  const jobs = new JobStore();
  const boom = new Error('temporal unreachable');
  const deps = baseDeps({
    jobs,
    extractAndSnapshot: async () => extractionResult('TEST-U-FAIL3'),
    extractArticleAndSnapshot: async () => articleResult('TEST-U-FAIL3-A'),
    startReview: async () => {
      throw boom;
    },
  });
  const handlers = createHandlers(deps);
  const result = await handlers.postRuns(uploadForm('TEST-U-FAIL3.pdf', 'TEST-U-FAIL3-A.pdf'));
  trackUpload('TEST-U-FAIL3', 'TEST-U-FAIL3-A');
  const jobId = (result.body as { jobId: string }).jobId;

  await waitUntil(() => jobs.get(jobId)?.status === 'failed');
  assert.equal(jobs.get(jobId)?.error, String(boom));
});

test('postRuns: WorkflowExecutionAlreadyStartedError from startReview attaches instead of failing', async () => {
  const jobs = new JobStore();
  const deps = baseDeps({
    jobs,
    extractAndSnapshot: async () => extractionResult('TEST-U-ALREADY'),
    extractArticleAndSnapshot: async () => articleResult('TEST-U-ALREADY-A'),
    startReview: async () => {
      throw new WorkflowExecutionAlreadyStartedError('already started', 'review-TEST-U-ALREADY', 'reviewLcd');
    },
  });
  const handlers = createHandlers(deps);
  const result = await handlers.postRuns(uploadForm('TEST-U-ALREADY.pdf', 'TEST-U-ALREADY-A.pdf'));
  trackUpload('TEST-U-ALREADY', 'TEST-U-ALREADY-A');
  const jobId = (result.body as { jobId: string }).jobId;

  await waitUntil(() => jobs.get(jobId)?.status === 'attached');
  assert.equal(jobs.get(jobId)?.workflowId, 'review-TEST-U-ALREADY');
});

test('getRuns: mergeStatus output includes worker-unavailable and workflow-failed rows', async () => {
  const jobs = new JobStore();
  const job1 = jobs.create('TEST-U-G1', 'TEST-U-G1-A', () => new Date().toISOString());
  jobs.markStartingReview(job1.id);
  jobs.markAttached(job1.id, 'review-TEST-U-G1');

  const infos: ReviewWorkflowInfo[] = [
    { workflowId: 'review-TEST-U-G1', status: 'RUNNING' },
    { workflowId: 'review-TEST-U-G2', status: 'FAILED' },
  ];
  const deps = baseDeps({
    jobs,
    listReviewWorkflows: async () => infos,
    queryReviewStatus: async () => 'worker-unavailable',
  });
  const handlers = createHandlers(deps);
  const result = await handlers.getRuns();

  assert.equal(result.status, 200);
  const entries = result.body as Array<{ lcdId: string; phase: string }>;
  assert.equal(entries.find((e) => e.lcdId === 'TEST-U-G1')?.phase, 'worker-unavailable');
  assert.equal(entries.find((e) => e.lcdId === 'TEST-U-G2')?.phase, 'workflow-failed');
});

test('getRuns: caches a COMPLETED workflow result across repeated polls', async () => {
  let calls = 0;
  const deps = baseDeps({
    listReviewWorkflows: async () => [{ workflowId: 'review-TEST-U-G3', status: 'COMPLETED' }],
    getReviewResult: async () => {
      calls += 1;
      return { lcdId: 'TEST-U-G3', outcome: 'approved' };
    },
  });
  const handlers = createHandlers(deps);
  await handlers.getRuns();
  await handlers.getRuns();
  assert.equal(calls, 1);
});

test('getReview: an invalid workflow id → 400', async () => {
  const handlers = createHandlers(baseDeps());
  const result = await handlers.getReview('not-a-review-id');
  assert.equal(result.status, 400);
});

test('getReview: a readSubgraph "not found" error maps to 404 and still closes the graph', async () => {
  const graph = fakeGraph();
  const deps = baseDeps({
    createGraph: () => graph,
    readSubgraph: async () => {
      throw new Error('LCD "TEST-U-R1" not found in the graph — run: node cli.ts load TEST-U-R1');
    },
  });
  const handlers = createHandlers(deps);
  const result = await handlers.getReview('review-TEST-U-R1');
  assert.equal(result.status, 404);
  assert.equal(graph.closed, true);
});

test('getReview: success returns the subgraph and closes the graph', async () => {
  const graph = fakeGraph();
  const subgraph: ApprovedSubgraph = {
    lcd: { id: 'TEST-U-R2', status: 'draft', sourceHash: 'h' },
    requirements: [],
    coveredCodes: [],
  };
  const deps = baseDeps({ createGraph: () => graph, readSubgraph: async () => subgraph });
  const handlers = createHandlers(deps);
  const result = await handlers.getReview('review-TEST-U-R2');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, subgraph);
  assert.equal(graph.closed, true);
});

test('postSignal: an invalid body (missing reviewer) → 400', async () => {
  const handlers = createHandlers(baseDeps());
  const result = await handlers.postSignal('review-TEST-U-S1', { decision: 'approve' });
  assert.equal(result.status, 400);
});

test('postSignal: success → 200', async () => {
  const handlers = createHandlers(baseDeps({ signalReview: async () => {} }));
  const result = await handlers.postSignal('review-TEST-U-S2', { decision: 'approve', reviewer: 'Alice' });
  assert.equal(result.status, 200);
});

test('postSignal: WorkflowNotFoundError, and describeReview also throws → 404', async () => {
  const deps = baseDeps({
    signalReview: async () => {
      throw new WorkflowNotFoundError('not found', 'review-TEST-U-S3', undefined);
    },
    describeReview: async () => {
      throw new Error('also not found');
    },
  });
  const handlers = createHandlers(deps);
  const result = await handlers.postSignal('review-TEST-U-S3', { decision: 'approve', reviewer: 'Alice' });
  assert.equal(result.status, 404);
});

test('postSignal: WorkflowNotFoundError, and describeReview reports a closed status → 409', async () => {
  const deps = baseDeps({
    signalReview: async () => {
      throw new WorkflowNotFoundError('not found', 'review-TEST-U-S4', undefined);
    },
    describeReview: async () => ({ workflowId: 'review-TEST-U-S4', status: 'COMPLETED' as const }),
  });
  const handlers = createHandlers(deps);
  const result = await handlers.postSignal('review-TEST-U-S4', { decision: 'approve', reviewer: 'Alice' });
  assert.equal(result.status, 409);
});

test('postSignal: WorkflowNotFoundError, and describeReview reports RUNNING rethrows the contradiction', async () => {
  const deps = baseDeps({
    signalReview: async () => {
      throw new WorkflowNotFoundError('not found', 'review-TEST-U-S5', undefined);
    },
    describeReview: async () => ({ workflowId: 'review-TEST-U-S5', status: 'RUNNING' as const }),
  });
  const handlers = createHandlers(deps);
  await assert.rejects(() => handlers.postSignal('review-TEST-U-S5', { decision: 'approve', reviewer: 'Alice' }));
});

test('postProject: an invalid lcd id → 400', async () => {
  const handlers = createHandlers(baseDeps());
  const result = await handlers.postProject('bad id!');
  assert.equal(result.status, 400);
});

test('postProject: the "not approved" error maps to 409', async () => {
  const deps = baseDeps({
    projectAndWrite: async () => {
      throw new Error('LCD "TEST-U-P1" is not approved (status: "draft") — its review has not been approved.');
    },
  });
  const handlers = createHandlers(deps);
  const result = await handlers.postProject('TEST-U-P1');
  assert.equal(result.status, 409);
});

test('postProject: success returns paths and artifacts', async () => {
  const deps = baseDeps({
    projectAndWrite: async (lcdId) => ({
      paths: {
        crd: `out/${lcdId}.crd.json`,
        dtr: `out/${lcdId}.dtr.json`,
        planDefinition: `out/${lcdId}.plandefinition.json`,
      },
      artifacts: { crd: {}, dtr: {}, planDefinition: {} },
    }),
  });
  const handlers = createHandlers(deps);
  const result = await handlers.postProject('TEST-U-P2');
  assert.equal(result.status, 200);
});
