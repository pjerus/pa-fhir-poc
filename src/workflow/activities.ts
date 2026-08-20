import { ApplicationFailure } from '@temporalio/common';

import { loadGraphConfig } from '../graph/config.ts';
import { createGraph } from '../graph/db.ts';
import { ensureConstraints, NODE } from '../graph/schema.ts';
import { loadSubgraph } from '../graph/write.ts';
import type { LoadSubgraphInput } from '../graph/write.ts';
import { validateGraph } from '../graph/validate.ts';
import type { ReviewDecision } from '../types.ts';

/**
 * Plain, Temporal-free async functions so they're testable without a worker.
 * Each opens its own Graph and closes it in `finally` — no shared connection
 * pool across activities, which mirrors how Temporal would actually invoke
 * them (independently, possibly on different workers).
 */

/** Upserts the proposed LCD (and its paired article, if any) into the graph. */
export async function propose(input: LoadSubgraphInput): Promise<void> {
  const graph = createGraph(loadGraphConfig());
  try {
    await ensureConstraints(graph);
    await loadSubgraph(graph, input);
  } finally {
    await graph.close();
  }
}

/**
 * Runs the whole-graph structural validation (same semantics as `cli.ts
 * load`) and fails the activity if it's unclean — a reviewer should never be
 * asked to approve a graph that failed structural validation.
 */
export async function validate(lcdId: string): Promise<void> {
  const graph = createGraph(loadGraphConfig());
  try {
    const report = await validateGraph(graph);
    if (!report.clean) {
      throw ApplicationFailure.nonRetryable(
        `Graph validation failed while reviewing LCD "${lcdId}": ${JSON.stringify(report.issues)}`,
      );
    }
  } finally {
    await graph.close();
  }
}

async function setReviewProvenance(
  lcdId: string,
  decision: ReviewDecision,
  extraSet: string,
): Promise<void> {
  const graph = createGraph(loadGraphConfig());
  try {
    const rows = await graph.run(
      `
      MATCH (lcd:${NODE.LCD} {id: $lcdId})
      SET ${extraSet}
        lcd.lastReviewDecision = $decision,
        lcd.lastReviewer = $reviewer,
        lcd.lastReviewNote = $note
      RETURN count(lcd) AS count
      `,
      { lcdId, decision: decision.decision, reviewer: decision.reviewer, note: decision.note ?? null },
    );
    if ((rows[0]?.count as number) === 0) {
      throw new Error(`Cannot record review decision: no LCD with id "${lcdId}" exists.`);
    }
  } finally {
    await graph.close();
  }
}

/** Approves the LCD and stamps review provenance. */
export async function commit(lcdId: string, decision: ReviewDecision): Promise<void> {
  await setReviewProvenance(lcdId, decision, `lcd.status = 'approved',`);
}

/** Leaves the LCD draft but still stamps review provenance. */
export async function compensate(lcdId: string, decision: ReviewDecision): Promise<void> {
  await setReviewProvenance(lcdId, decision, '');
}
