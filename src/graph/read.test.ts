import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { loadGraphConfig } from './config.ts';
import { createGraph } from './db.ts';
import type { Graph } from './db.ts';
import { ensureConstraints } from './schema.ts';
import { loadSubgraph } from './write.ts';
import { readApprovedSubgraph } from './read.ts';
import type { ArticleInput, LcdInput } from '../types.ts';

let graph: Graph;

async function cleanupTestData(): Promise<void> {
  await graph.run(`
    MATCH (n)
    WHERE n.id STARTS WITH 'TEST-R-' OR n.code STARTS WITH 'TEST-R-'
    DETACH DELETE n
  `);
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
    id: 'TEST-R-L1',
    title: 'Test LCD',
    version: '1',
    sourceHash: 'TEST-R-hash-1',
    // Inserted out of ordinal order to prove readApprovedSubgraph sorts them.
    requirements: [
      { id: 'TEST-R-L1-R2', text: 'Requirement two', ordinal: 2, category: 'documentation' },
      { id: 'TEST-R-L1-R1', text: 'Requirement one', ordinal: 1, category: 'indication' },
    ],
    coveredCodes: [
      { system: 'TEST-R-HCPCS', code: 'TEST-R-E0607' },
      { system: 'TEST-R-HCPCS', code: 'TEST-R-A4253' },
    ],
    ...overrides,
  };
}

function articleFixture(overrides: Partial<ArticleInput> = {}): ArticleInput {
  return {
    id: 'TEST-R-A1',
    title: 'Test Article',
    version: '1',
    sourceHash: 'TEST-R-hash-a1',
    listedCodes: [{ system: 'TEST-R-HCPCS', code: 'TEST-R-E0607' }],
    denialReasons: [{ id: 'TEST-R-A1-D1', text: 'Denial reason one' }],
    ...overrides,
  };
}

async function approve(lcdId: string): Promise<void> {
  await graph.run(`MATCH (lcd:LCD {id: $id}) SET lcd.status = 'approved'`, { id: lcdId });
}

test('readApprovedSubgraph returns requirements ordered by ordinal, coveredCodes, and no article when none exists', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: lcdFixture() });
  await approve('TEST-R-L1');

  const result = await readApprovedSubgraph(graph, 'TEST-R-L1');

  assert.equal(result.lcd.id, 'TEST-R-L1');
  assert.equal(result.lcd.title, 'Test LCD');
  assert.equal(result.lcd.version, '1');
  assert.equal(result.lcd.status, 'approved');
  assert.equal(result.lcd.sourceHash, 'TEST-R-hash-1');

  assert.deepEqual(
    result.requirements.map((r) => r.id),
    ['TEST-R-L1-R1', 'TEST-R-L1-R2'],
  );
  assert.deepEqual(
    result.requirements.map((r) => r.ordinal),
    [1, 2],
  );

  const sortedCodes = [...result.coveredCodes].sort((a, b) => a.code.localeCompare(b.code));
  assert.deepEqual(sortedCodes, [
    { system: 'TEST-R-HCPCS', code: 'TEST-R-A4253' },
    { system: 'TEST-R-HCPCS', code: 'TEST-R-E0607' },
  ]);

  assert.equal(result.article, undefined);
});

test('readApprovedSubgraph includes the article block when an article exists', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: lcdFixture(), article: articleFixture() });
  await approve('TEST-R-L1');

  const result = await readApprovedSubgraph(graph, 'TEST-R-L1');

  assert.ok(result.article, 'expected an article block');
  assert.equal(result.article?.id, 'TEST-R-A1');
  assert.equal(result.article?.sourceHash, 'TEST-R-hash-a1');
  assert.deepEqual(result.article?.listedCodes, [{ system: 'TEST-R-HCPCS', code: 'TEST-R-E0607' }]);
  assert.deepEqual(result.article?.denialReasons, [{ id: 'TEST-R-A1-D1', text: 'Denial reason one' }]);
});

test('readApprovedSubgraph throws when the LCD is absent', async () => {
  await cleanupTestData();

  await assert.rejects(
    () => readApprovedSubgraph(graph, 'TEST-R-MISSING'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /TEST-R-MISSING/);
      assert.match(error.message, /run: node cli\.ts load TEST-R-MISSING/);
      return true;
    },
  );
});

test('readApprovedSubgraph throws naming the actual status when the LCD is not approved', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: lcdFixture() }); // stays 'draft'

  await assert.rejects(
    () => readApprovedSubgraph(graph, 'TEST-R-L1'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /draft/);
      assert.match(error.message, /its review has not been approved/);
      return true;
    },
  );
});
