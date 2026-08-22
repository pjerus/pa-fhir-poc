import test from 'node:test';
import assert from 'node:assert/strict';

import { JobStore, type Job, type JobStatus } from './jobs.ts';

test('JobStore.create returns a new job with extracting status', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');

  assert.ok(job.id);
  assert.equal(job.lcdId, 'TEST-L1');
  assert.equal(job.articleId, 'TEST-A1');
  assert.equal(job.status, 'extracting');
  assert.equal(job.createdAt, '2026-08-21T00:00:00Z');
  assert.equal(job.workflowId, undefined);
  assert.equal(job.error, undefined);
});

test('JobStore.create is idempotent when job is in extracting status', () => {
  const store = new JobStore();
  const job1 = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  const job2 = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T01:00:00Z');

  assert.equal(job1.id, job2.id);
  assert.equal(job1.status, 'extracting');
  assert.equal(job2.status, 'extracting');
});

test('JobStore.create is idempotent when job is in starting-review status', () => {
  const store = new JobStore();
  const job1 = store.create('TEST-L2', 'TEST-A2', () => '2026-08-21T00:00:00Z');
  store.markStartingReview(job1.id);

  const job2 = store.create('TEST-L2', 'TEST-A2', () => '2026-08-21T01:00:00Z');

  assert.equal(job1.id, job2.id);
  assert.equal(job2.status, 'starting-review');
});

test('JobStore.create makes a fresh job after previous one failed', () => {
  const store = new JobStore();
  const job1 = store.create('TEST-L3', 'TEST-A3', () => '2026-08-21T00:00:00Z');
  store.markFailed(job1.id, 'extraction error');

  const job2 = store.create('TEST-L3', 'TEST-A3', () => '2026-08-21T01:00:00Z');

  assert.notEqual(job1.id, job2.id);
  assert.equal(job1.status, 'failed');
  assert.equal(job2.status, 'extracting');
});

test('JobStore.get returns job by id', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');

  const retrieved = store.get(job.id);

  assert.deepEqual(retrieved, job);
});

test('JobStore.get returns undefined for unknown id', () => {
  const store = new JobStore();

  const retrieved = store.get('unknown-id');

  assert.equal(retrieved, undefined);
});

test('JobStore.list returns all jobs', () => {
  const store = new JobStore();
  const job1 = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  const job2 = store.create('TEST-L2', 'TEST-A2', () => '2026-08-21T00:00:00Z');

  const jobs = store.list();

  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], job1);
  assert.deepEqual(jobs[1], job2);
});

test('JobStore.markStartingReview transitions extracting job to starting-review', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');

  store.markStartingReview(job.id);

  const updated = store.get(job.id);
  assert.equal(updated?.status, 'starting-review');
});

test('JobStore.markStartingReview throws on unknown id', () => {
  const store = new JobStore();

  assert.throws(() => {
    store.markStartingReview('unknown-id');
  }, /unknown job/i);
});

test('JobStore.markStartingReview throws on wrong prior status', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  store.markStartingReview(job.id);

  assert.throws(() => {
    store.markStartingReview(job.id);
  }, /wrong prior state/i);
});

test('JobStore.markAttached transitions starting-review job to attached', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');
  store.markStartingReview(job.id);

  store.markAttached(job.id, 'wf-123');

  const updated = store.get(job.id);
  assert.equal(updated?.status, 'attached');
  assert.equal(updated?.workflowId, 'wf-123');
});

test('JobStore.markAttached throws on unknown id', () => {
  const store = new JobStore();

  assert.throws(() => {
    store.markAttached('unknown-id', 'wf-123');
  }, /unknown job/i);
});

test('JobStore.markAttached throws on wrong prior status', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');

  assert.throws(() => {
    store.markAttached(job.id, 'wf-123');
  }, /wrong prior state/i);
});

test('JobStore.markFailed sets error and status', () => {
  const store = new JobStore();
  const job = store.create('TEST-L1', 'TEST-A1', () => '2026-08-21T00:00:00Z');

  store.markFailed(job.id, 'extraction failed');

  const updated = store.get(job.id);
  assert.equal(updated?.status, 'failed');
  assert.equal(updated?.error, 'extraction failed');
});

test('JobStore.markFailed throws on unknown id', () => {
  const store = new JobStore();

  assert.throws(() => {
    store.markFailed('unknown-id', 'error');
  }, /unknown job/i);
});
