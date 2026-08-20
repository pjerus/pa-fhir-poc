import { Client, Connection } from '@temporalio/client';

import { loadTemporalConfig } from './config.ts';
import { reviewLcd, reviewSignal } from './review.workflow.ts';
import type { ReviewInput, ReviewResult } from './review.workflow.ts';
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
    return await client.workflow.getHandle(workflowId).result();
  } finally {
    await connection.close();
  }
}
