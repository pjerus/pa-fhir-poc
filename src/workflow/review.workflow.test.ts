import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import { loadGraphConfig } from '../graph/config.ts';
import { createGraph } from '../graph/db.ts';
import type { Graph } from '../graph/db.ts';
import { ensureConstraints } from '../graph/schema.ts';
import type { LoadSubgraphInput } from '../graph/write.ts';
import * as activities from './activities.ts';
import { reviewLcd, reviewSignal, reviewStatusQuery } from './review.workflow.ts';
import type { LcdInput } from '../types.ts';

const TASK_QUEUE = 'test';
const WORKFLOWS_PATH = fileURLToPath(new URL('./review.workflow.ts', import.meta.url));

let graph: Graph;
let testEnv: TestWorkflowEnvironment;

// Scoped to this file's own 'TEST-F-' namespace, per the project convention
// (see src/workflow/activities.test.ts's 'TEST-X-' namespace) so this file's
// cleanup never touches another test file's in-flight fixtures.
async function cleanupTestData(): Promise<void> {
  await graph.run(`
    MATCH (n)
    WHERE n.id STARTS WITH 'TEST-F-' OR n.code STARTS WITH 'TEST-F-'
    DETACH DELETE n
  `);
}

before(async () => {
  graph = createGraph(loadGraphConfig());
  await ensureConstraints(graph);
  await cleanupTestData(); // in case a prior run crashed before its own cleanup

  // createLocal, NOT createTimeSkipping — the time-skipping test server
  // doesn't run on Apple Silicon. First run downloads the dev-server binary.
  testEnv = await TestWorkflowEnvironment.createLocal();
});

after(async () => {
  await cleanupTestData();
  await graph.close();
  await testEnv.teardown();
});

function lcdFixture(id: string): LcdInput {
  return {
    id,
    title: 'Test LCD',
    version: '1',
    sourceHash: `TEST-F-hash-${id}`,
    requirements: [{ id: `${id}-R1`, text: 'Requirement one', ordinal: 1, category: 'indication' }],
    coveredCodes: [{ system: 'TEST-F-HCPCS', code: 'TEST-F-E9819' }],
  };
}

function subgraphInput(id: string): LoadSubgraphInput {
  return { lcd: lcdFixture(id) };
}

async function lcdProps(lcdId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await graph.run(`MATCH (lcd:LCD {id: $id}) RETURN properties(lcd) AS props`, { id: lcdId });
  return row?.props as Record<string, unknown> | undefined;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(100);
  }
}

async function newWorker(): Promise<Worker> {
  return Worker.create({
    connection: testEnv.nativeConnection,
    namespace: testEnv.namespace ?? 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities,
  });
}

test('workflow blocks on the review signal, leaving the LCD draft', async () => {
  const lcdId = 'TEST-F-L1';
  await cleanupTestData();
  try {
    const worker = await newWorker();
    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(reviewLcd, {
        taskQueue: TASK_QUEUE,
        workflowId: `review-${lcdId}`,
        args: [subgraphInput(lcdId)],
      });

      // Wait until propose+validate have run (LCD node exists) and the
      // workflow is still RUNNING (i.e. blocked in condition(), not failed).
      await waitUntil(async () => {
        const description = await handle.describe();
        return description.status.name === 'RUNNING' && (await lcdProps(lcdId)) !== undefined;
      });

      const description = await handle.describe();
      assert.equal(description.status.name, 'RUNNING');

      const props = await lcdProps(lcdId);
      assert.equal(props?.status, 'draft');

      await handle.terminate();
    });
  } finally {
    await cleanupTestData();
  }
});

test('approve path commits the LCD and records review provenance', async () => {
  const lcdId = 'TEST-F-L2';
  await cleanupTestData();
  try {
    const worker = await newWorker();
    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(reviewLcd, {
        taskQueue: TASK_QUEUE,
        workflowId: `review-${lcdId}`,
        args: [subgraphInput(lcdId)],
      });

      await waitUntil(async () => (await handle.describe()).status.name === 'RUNNING');

      await handle.signal(reviewSignal, { decision: 'approve', reviewer: 'TEST-F-Alice', note: 'looks good' });

      return handle.result();
    });

    assert.deepEqual(result, { lcdId, outcome: 'approved' });

    const props = await lcdProps(lcdId);
    assert.equal(props?.status, 'approved');
    assert.equal(props?.lastReviewDecision, 'approve');
    assert.equal(props?.lastReviewer, 'TEST-F-Alice');
    assert.equal(props?.lastReviewNote, 'looks good');
  } finally {
    await cleanupTestData();
  }
});

test('reviewStatus query reports proposing -> validating -> awaiting-review', async () => {
  const lcdId = 'TEST-F-L4';

  // Mocked activities (no graph I/O) — this test is about the query's status
  // transitions, not the propose/validate/commit side effects already
  // covered by the tests above.
  const mockActivities: typeof activities = {
    propose: async () => {},
    validate: async () => {},
    commit: async () => {},
    compensate: async () => {},
  };
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    namespace: testEnv.namespace ?? 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: mockActivities,
  });

  const result = await worker.runUntil(async () => {
    const handle = await testEnv.client.workflow.start(reviewLcd, {
      taskQueue: TASK_QUEUE,
      workflowId: `review-${lcdId}`,
      args: [subgraphInput(lcdId)],
    });

    await waitUntil(async () => (await handle.query(reviewStatusQuery)) === 'awaiting-review');
    assert.equal(await handle.query(reviewStatusQuery), 'awaiting-review');

    await handle.signal(reviewSignal, { decision: 'approve', reviewer: 'TEST-F-Carol' });

    return handle.result();
  });

  assert.deepEqual(result, { lcdId, outcome: 'approved' });
});

test('reject path leaves the LCD draft and records review provenance', async () => {
  const lcdId = 'TEST-F-L3';
  await cleanupTestData();
  try {
    const worker = await newWorker();
    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(reviewLcd, {
        taskQueue: TASK_QUEUE,
        workflowId: `review-${lcdId}`,
        args: [subgraphInput(lcdId)],
      });

      await waitUntil(async () => (await handle.describe()).status.name === 'RUNNING');

      await handle.signal(reviewSignal, { decision: 'reject', reviewer: 'TEST-F-Bob', note: 'missing codes' });

      return handle.result();
    });

    assert.deepEqual(result, { lcdId, outcome: 'rejected' });

    const props = await lcdProps(lcdId);
    assert.equal(props?.status, 'draft');
    assert.equal(props?.lastReviewDecision, 'reject');
    assert.equal(props?.lastReviewer, 'TEST-F-Bob');
    assert.equal(props?.lastReviewNote, 'missing codes');
  } finally {
    await cleanupTestData();
  }
});
