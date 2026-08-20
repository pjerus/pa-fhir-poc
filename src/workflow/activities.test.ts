import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { loadGraphConfig } from '../graph/config.ts';
import { createGraph } from '../graph/db.ts';
import type { Graph } from '../graph/db.ts';
import { ensureConstraints } from '../graph/schema.ts';
import type { LoadSubgraphInput } from '../graph/write.ts';
import { propose, validate, commit, compensate } from './activities.ts';
import type { LcdInput } from '../types.ts';

let graph: Graph;

// Scoped to this file's own 'TEST-X-' namespace, per the project convention
// (see src/graph/write.test.ts and src/graph/validate.test.ts) so this
// file's cleanup never touches another test file's in-flight fixtures.
async function cleanupTestData(): Promise<void> {
  await graph.run(`
    MATCH (n)
    WHERE n.id STARTS WITH 'TEST-X-' OR n.code STARTS WITH 'TEST-X-'
    DETACH DELETE n
  `);
}

async function isolated(name: string, fn: () => Promise<void>): Promise<void> {
  test(name, async () => {
    await cleanupTestData();
    try {
      await fn();
    } finally {
      await cleanupTestData();
    }
  });
}

before(async () => {
  graph = createGraph(loadGraphConfig());
  await ensureConstraints(graph);
  await cleanupTestData(); // in case a prior run crashed before its own cleanup
});

after(async () => {
  await cleanupTestData();
  await graph.close();
});

function lcdFixture(overrides: Partial<LcdInput> = {}): LcdInput {
  return {
    id: 'TEST-X-L1',
    title: 'Test LCD',
    version: '1',
    sourceHash: 'TEST-X-hash-1',
    requirements: [
      { id: 'TEST-X-L1-R1', text: 'Requirement one', ordinal: 1, category: 'indication' },
      { id: 'TEST-X-L1-R2', text: 'Requirement two', ordinal: 2, category: 'documentation' },
    ],
    coveredCodes: [{ system: 'TEST-X-HCPCS', code: 'TEST-X-E9819' }],
    ...overrides,
  };
}

function subgraphInput(overrides: Partial<LcdInput> = {}): LoadSubgraphInput {
  return { lcd: lcdFixture(overrides) };
}

async function lcdProps(lcdId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await graph.run(`MATCH (lcd:LCD {id: $id}) RETURN properties(lcd) AS props`, { id: lcdId });
  return row?.props as Record<string, unknown> | undefined;
}

isolated('propose loads the subgraph', async () => {
  await propose(subgraphInput());

  const props = await lcdProps('TEST-X-L1');
  assert.ok(props, 'expected the LCD node to exist');
  assert.equal(props?.status, 'draft');

  const [reqCount] = await graph.run(`MATCH (:LCD {id: $id})-[:REQUIRES]->(r) RETURN count(r) AS count`, {
    id: 'TEST-X-L1',
  });
  assert.equal(reqCount?.count, 2);
});

isolated('validate passes on a clean fixture', async () => {
  await propose(subgraphInput());

  await assert.doesNotReject(() => validate('TEST-X-L1'));
});

isolated('validate throws naming an injected orphan', async () => {
  await propose(subgraphInput());
  await graph.run(`CREATE (:Code {system: 'TEST-X-HCPCS', code: 'TEST-X-ORPHAN'})`);

  await assert.rejects(() => validate('TEST-X-L1'), (error: Error) => {
    assert.match(error.message, /TEST-X-ORPHAN/);
    return true;
  });
});

isolated('commit flips status to approved and writes review provenance', async () => {
  await propose(subgraphInput());

  await commit('TEST-X-L1', { decision: 'approve', reviewer: 'TEST-X-Alice', note: 'looks good' });

  const props = await lcdProps('TEST-X-L1');
  assert.equal(props?.status, 'approved');
  assert.equal(props?.lastReviewDecision, 'approve');
  assert.equal(props?.lastReviewer, 'TEST-X-Alice');
  assert.equal(props?.lastReviewNote, 'looks good');
});

isolated('commit with no note leaves lastReviewNote absent from the node', async () => {
  await propose(subgraphInput());

  await commit('TEST-X-L1', { decision: 'approve', reviewer: 'TEST-X-Alice' });

  const props = await lcdProps('TEST-X-L1');
  assert.equal(props?.status, 'approved');
  assert.ok(!('lastReviewNote' in (props ?? {})), 'lastReviewNote must be absent, not null');
});

isolated('compensate leaves the LCD draft and writes review provenance', async () => {
  await propose(subgraphInput());

  await compensate('TEST-X-L1', { decision: 'reject', reviewer: 'TEST-X-Bob', note: 'missing codes' });

  const props = await lcdProps('TEST-X-L1');
  assert.equal(props?.status, 'draft');
  assert.equal(props?.lastReviewDecision, 'reject');
  assert.equal(props?.lastReviewer, 'TEST-X-Bob');
  assert.equal(props?.lastReviewNote, 'missing codes');
});

isolated('compensate with no note leaves lastReviewNote absent from the node', async () => {
  await propose(subgraphInput());

  await compensate('TEST-X-L1', { decision: 'reject', reviewer: 'TEST-X-Bob' });

  const props = await lcdProps('TEST-X-L1');
  assert.equal(props?.status, 'draft');
  assert.ok(!('lastReviewNote' in (props ?? {})), 'lastReviewNote must be absent, not null');
});

isolated('commit on a missing LCD throws naming the lcdId', async () => {
  await assert.rejects(
    () => commit('TEST-X-MISSING', { decision: 'approve', reviewer: 'TEST-X-Alice' }),
    (error: Error) => {
      assert.match(error.message, /TEST-X-MISSING/);
      return true;
    },
  );
});

isolated('compensate on a missing LCD throws naming the lcdId', async () => {
  await assert.rejects(
    () => compensate('TEST-X-MISSING', { decision: 'reject', reviewer: 'TEST-X-Bob' }),
    (error: Error) => {
      assert.match(error.message, /TEST-X-MISSING/);
      return true;
    },
  );
});
