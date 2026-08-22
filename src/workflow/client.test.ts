import test from 'node:test';
import assert from 'node:assert/strict';

import { withWorkerTimeout } from './client.ts';

// Pure logic only — no live Temporal. Covers the race between a settling
// promise and the client-side timeout, per the plan's Task 4 Step 2.

test('withWorkerTimeout resolves with the promise value when it settles first', async () => {
  const result = await withWorkerTimeout(Promise.resolve('awaiting-review'), 1000);
  assert.equal(result, 'awaiting-review');
});

test('withWorkerTimeout returns worker-unavailable when the promise never settles before the timeout', async () => {
  const hangs = new Promise<string>(() => {});
  const result = await withWorkerTimeout(hangs, 20);
  assert.equal(result, 'worker-unavailable');
});

test('withWorkerTimeout rethrows a rejection from the promise', async () => {
  const boom = new Error('boom');
  await assert.rejects(withWorkerTimeout(Promise.reject(boom), 1000), boom);
});
