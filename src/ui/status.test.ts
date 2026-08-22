import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeStatus, type WorkflowSnapshot } from './status.ts';
import { JobStore } from './jobs.ts';

test('mergeStatus: job extracting, no workflow → phase extracting', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');

  const entries = mergeStatus([job], []);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L1',
    jobId: job.id,
    phase: 'extracting',
  });
});

test('mergeStatus: job starting-review, no workflow → phase starting-review', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  store.markStartingReview(job.id);

  const entries = mergeStatus([job], []);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L1',
    jobId: job.id,
    phase: 'starting-review',
  });
});

test('mergeStatus: job failed → phase failed with error', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  store.markFailed(job.id, 'extraction failed');

  const entries = mergeStatus([job], []);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L1',
    jobId: job.id,
    phase: 'failed',
    error: 'extraction failed',
  });
});

test('mergeStatus: job attached + RUNNING workflow with validating reviewStatus → phase validating', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  store.markStartingReview(job.id);
  store.markAttached(job.id, 'review-TEST-L1');

  const workflows: readonly WorkflowSnapshot[] = [
    {
      workflowId: 'review-TEST-L1',
      status: 'RUNNING',
      reviewStatus: 'validating',
    },
  ];

  const entries = mergeStatus([job], workflows);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L1',
    jobId: job.id,
    workflowId: 'review-TEST-L1',
    phase: 'validating',
  });
});

test('mergeStatus: RUNNING workflow with worker-unavailable reviewStatus → phase worker-unavailable', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  store.markStartingReview(job.id);
  store.markAttached(job.id, 'review-TEST-L1');

  const workflows: readonly WorkflowSnapshot[] = [
    {
      workflowId: 'review-TEST-L1',
      status: 'RUNNING',
      reviewStatus: 'worker-unavailable',
    },
  ];

  const entries = mergeStatus([job], workflows);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L1',
    jobId: job.id,
    workflowId: 'review-TEST-L1',
    phase: 'worker-unavailable',
  });
});

test('mergeStatus: COMPLETED workflow with approved outcome → phase approved', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  store.markStartingReview(job.id);
  store.markAttached(job.id, 'review-TEST-L1');

  const workflows: readonly WorkflowSnapshot[] = [
    {
      workflowId: 'review-TEST-L1',
      status: 'COMPLETED',
      outcome: 'approved',
    },
  ];

  const entries = mergeStatus([job], workflows);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L1',
    jobId: job.id,
    workflowId: 'review-TEST-L1',
    phase: 'approved',
  });
});

test('mergeStatus: COMPLETED workflow with rejected outcome → phase rejected', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  store.markStartingReview(job.id);
  store.markAttached(job.id, 'review-TEST-L1');

  const workflows: readonly WorkflowSnapshot[] = [
    {
      workflowId: 'review-TEST-L1',
      status: 'COMPLETED',
      outcome: 'rejected',
    },
  ];

  const entries = mergeStatus([job], workflows);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L1',
    jobId: job.id,
    workflowId: 'review-TEST-L1',
    phase: 'rejected',
  });
});

test('mergeStatus: FAILED workflow → phase workflow-failed with failureReason as error', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  store.markStartingReview(job.id);
  store.markAttached(job.id, 'review-TEST-L1');

  const workflows: readonly WorkflowSnapshot[] = [
    {
      workflowId: 'review-TEST-L1',
      status: 'FAILED',
      failureReason: 'activity failed',
    },
  ];

  const entries = mergeStatus([job], workflows);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L1',
    jobId: job.id,
    workflowId: 'review-TEST-L1',
    phase: 'workflow-failed',
    error: 'activity failed',
  });
});

test('mergeStatus: TERMINATED workflow → phase workflow-failed', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  store.markStartingReview(job.id);
  store.markAttached(job.id, 'review-TEST-L1');

  const workflows: readonly WorkflowSnapshot[] = [
    {
      workflowId: 'review-TEST-L1',
      status: 'TERMINATED',
      failureReason: 'terminated by user',
    },
  ];

  const entries = mergeStatus([job], workflows);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L1',
    jobId: job.id,
    workflowId: 'review-TEST-L1',
    phase: 'workflow-failed',
    error: 'terminated by user',
  });
});

test('mergeStatus: TIMED_OUT workflow → phase workflow-failed', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  store.markStartingReview(job.id);
  store.markAttached(job.id, 'review-TEST-L1');

  const workflows: readonly WorkflowSnapshot[] = [
    {
      workflowId: 'review-TEST-L1',
      status: 'TIMED_OUT',
      failureReason: 'execution timed out',
    },
  ];

  const entries = mergeStatus([job], workflows);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L1',
    jobId: job.id,
    workflowId: 'review-TEST-L1',
    phase: 'workflow-failed',
    error: 'execution timed out',
  });
});

test('mergeStatus: workflow with no matching job (server restarted) → entry present, lcdId derived from workflowId', () => {
  const workflows: readonly WorkflowSnapshot[] = [
    {
      workflowId: 'review-TEST-L2',
      status: 'RUNNING',
      reviewStatus: 'validating',
    },
  ];

  const entries = mergeStatus([], workflows);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L2',
    workflowId: 'review-TEST-L2',
    phase: 'validating',
  });
});

test('mergeStatus: multiple jobs and workflows', () => {
  const store = new JobStore();
  const job1 = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  const job2 = store.create('TEST-L2', 'TEST-A2', () => '2026-08-21T00:00:00Z');
  store.markFailed(job1.id, 'error1');
  store.markStartingReview(job2.id);
  store.markAttached(job2.id, 'review-TEST-L2');

  const workflows: readonly WorkflowSnapshot[] = [
    {
      workflowId: 'review-TEST-L2',
      status: 'COMPLETED',
      outcome: 'approved',
    },
    {
      workflowId: 'review-TEST-L3',
      status: 'RUNNING',
      reviewStatus: 'proposing',
    },
  ];

  const entries = mergeStatus([job1, job2], workflows);

  assert.equal(entries.length, 3);
  // job1 (failed)
  assert.deepEqual(entries[0], {
    lcdId: 'TEST-L1',
    jobId: job1.id,
    phase: 'failed',
    error: 'error1',
  });
  // job2 (attached + completed)
  assert.deepEqual(entries[1], {
    lcdId: 'TEST-L2',
    jobId: job2.id,
    workflowId: 'review-TEST-L2',
    phase: 'approved',
  });
  // workflow without job
  assert.deepEqual(entries[2], {
    lcdId: 'TEST-L3',
    workflowId: 'review-TEST-L3',
    phase: 'proposing',
  });
});

test('mergeStatus: dashed lcdId survives the review- prefix strip intact', () => {
  const entries = mergeStatus(
    [],
    [{ workflowId: 'review-TEST-L-1-2', status: 'RUNNING', reviewStatus: 'awaiting-review' }],
  );
  assert.equal(entries[0]?.lcdId, 'TEST-L-1-2');
});

test('mergeStatus: COMPLETED workflow without an outcome throws instead of fabricating one', () => {
  assert.throws(
    () => mergeStatus([], [{ workflowId: 'review-TEST-L1', status: 'COMPLETED' }]),
    /has no outcome/,
  );
});

test('mergeStatus: RUNNING workflow without a reviewStatus throws instead of guessing', () => {
  assert.throws(
    () => mergeStatus([], [{ workflowId: 'review-TEST-L1', status: 'RUNNING' }]),
    /has no reviewStatus/,
  );
});
