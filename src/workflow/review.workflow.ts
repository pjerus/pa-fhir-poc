import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';

import type { LoadSubgraphInput } from '../graph/write.ts';
import type { ReviewDecision } from '../types.ts';
import type * as activities from './activities.ts';

/** The workflow's input is data, not a file path — the client resolves fixtures. */
export type ReviewInput = LoadSubgraphInput;

export interface ReviewResult {
  readonly lcdId: string;
  readonly outcome: 'approved' | 'rejected';
}

/** Finer-grained than `describe()`'s coarse RUNNING/COMPLETED/... status. */
export type ReviewStatus = 'proposing' | 'validating' | 'awaiting-review';

export const reviewSignal = defineSignal<[ReviewDecision]>('review');
export const reviewStatusQuery = defineQuery<ReviewStatus>('reviewStatus');

const { propose, validate, commit, compensate } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

/**
 * Proposes the subgraph, validates it, then blocks indefinitely on a human
 * review signal — the block is the feature, not a bug. Approve commits
 * (status -> 'approved'); reject compensates (status stays 'draft'). Both
 * paths stamp review provenance on the LCD node.
 */
export async function reviewLcd(input: ReviewInput): Promise<ReviewResult> {
  const lcdId = input.lcd.id;

  let decision: ReviewDecision | undefined;
  setHandler(reviewSignal, (signaled) => {
    decision = signaled;
  });

  let status: ReviewStatus = 'proposing';
  setHandler(reviewStatusQuery, () => status);

  await propose(input);
  status = 'validating';
  await validate(lcdId);
  status = 'awaiting-review';

  await condition(() => decision !== undefined);

  if (decision!.decision === 'approve') {
    await commit(lcdId, decision!);
    return { lcdId, outcome: 'approved' };
  }

  await compensate(lcdId, decision!);
  return { lcdId, outcome: 'rejected' };
}
