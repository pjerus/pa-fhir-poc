import { Client, Connection, isGrpcDeadlineError } from '@temporalio/client';
import type { WorkflowExecutionStatusName } from '@temporalio/client';

import { loadTemporalConfig } from './config.ts';
import { reviewLcd, reviewSignal, reviewStatusQuery } from './review.workflow.ts';
import type { ReviewInput, ReviewResult, ReviewStatus } from './review.workflow.ts';
import type { ReviewDecision } from '../types.ts';

/** Starts the review workflow for `input.lcd.id`, returning its workflow id. */
export async function startReview(input: ReviewInput): Promise<string> {
  const { address, namespace, taskQueue } = loadTemporalConfig();

  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    const workflowId = `review-${input.lcd.id}`;
    await client.workflow.start(reviewLcd, {
      taskQueue,
      workflowId,
      args: [input],
    });
    return workflowId;
  } finally {
    await connection.close();
  }
}

/** Delivers the human's review decision to a running review workflow. */
export async function signalReview(workflowId: string, decision: ReviewDecision): Promise<void> {
  const { address, namespace } = loadTemporalConfig();

  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    await client.workflow.getHandle(workflowId).signal(reviewSignal, decision);
  } finally {
    await connection.close();
  }
}

/** Blocks indefinitely until the review workflow resolves — the block is the feature. */
export async function awaitReview(workflowId: string): Promise<ReviewResult> {
  const { address, namespace } = loadTemporalConfig();

  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    return await client.workflow.getHandle<typeof reviewLcd>(workflowId).result();
  } finally {
    await connection.close();
  }
}

/**
 * Coarse execution status, restricted to the values a review workflow can
 * actually reach — narrower than the SDK's full `WorkflowExecutionStatusName`
 * (which also covers `UNSPECIFIED`/`PAUSED`/`UNKNOWN`). Fails loud rather
 * than silently widening if the server ever reports one of those.
 */
export type WorkflowRuntimeStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TERMINATED'
  | 'CONTINUED_AS_NEW'
  | 'TIMED_OUT';

const KNOWN_RUNTIME_STATUSES: readonly WorkflowRuntimeStatus[] = [
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TERMINATED',
  'CONTINUED_AS_NEW',
  'TIMED_OUT',
];

function toRuntimeStatus(name: WorkflowExecutionStatusName): WorkflowRuntimeStatus {
  if ((KNOWN_RUNTIME_STATUSES as readonly string[]).includes(name)) {
    return name as WorkflowRuntimeStatus;
  }
  throw new Error(
    `Unexpected workflow execution status "${name}" — expected one of ${KNOWN_RUNTIME_STATUSES.join(', ')}.`,
  );
}

export interface ReviewWorkflowInfo {
  readonly workflowId: string;
  readonly status: WorkflowRuntimeStatus;
}

/** Lists every review workflow execution (any status) via server-side visibility. */
export async function listReviewWorkflows(): Promise<ReviewWorkflowInfo[]> {
  const { address, namespace } = loadTemporalConfig();

  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    const infos: ReviewWorkflowInfo[] = [];
    for await (const execution of client.workflow.list({ query: "WorkflowType = 'reviewLcd'" })) {
      infos.push({ workflowId: execution.workflowId, status: toRuntimeStatus(execution.status.name) });
    }
    return infos;
  } finally {
    await connection.close();
  }
}

/** Reads one review workflow's coarse status — never needs a worker to be polling. */
export async function describeReview(workflowId: string): Promise<ReviewWorkflowInfo> {
  const { address, namespace } = loadTemporalConfig();

  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    const description = await client.workflow.getHandle(workflowId).describe();
    return { workflowId, status: toRuntimeStatus(description.status.name) };
  } finally {
    await connection.close();
  }
}

/**
 * Races `promise` against a timer, resolving `'worker-unavailable'` if the
 * timer wins. Pure and worker-free so it's unit-testable without Temporal.
 */
export async function withWorkerTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'worker-unavailable'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'worker-unavailable'>((resolve) => {
        timer = setTimeout(() => resolve('worker-unavailable'), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Queries a review workflow's fine-grained status. Unlike `describeReview`,
 * a Query requires a worker to be polling the task queue — with none
 * running, the request hangs until it's rejected as a gRPC deadline error
 * (or our own client-side timer fires first). Either way that's reported as
 * `'worker-unavailable'`, not a thrown error: it's an expected, recoverable
 * state in a POC where the worker runs manually in its own terminal. Every
 * other failure (e.g. the workflow doesn't exist) still throws.
 */
export async function queryReviewStatus(
  workflowId: string,
  timeoutMs = 2000,
): Promise<ReviewStatus | 'worker-unavailable'> {
  const { address, namespace } = loadTemporalConfig();

  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    const handle = client.workflow.getHandle<typeof reviewLcd>(workflowId);
    try {
      return await withWorkerTimeout(handle.query(reviewStatusQuery), timeoutMs);
    } catch (err) {
      if (isGrpcDeadlineError(err)) return 'worker-unavailable';
      throw err;
    }
  } finally {
    await connection.close();
  }
}

/** Fetches a review workflow's result. Callers should only invoke this once `describeReview` reports COMPLETED. */
export async function getReviewResult(workflowId: string): Promise<ReviewResult> {
  const { address, namespace } = loadTemporalConfig();

  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    return await client.workflow.getHandle<typeof reviewLcd>(workflowId).result();
  } finally {
    await connection.close();
  }
}
