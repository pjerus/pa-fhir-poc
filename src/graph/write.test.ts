import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { loadGraphConfig } from './config.ts';
import { createGraph } from './db.ts';
import type { Graph } from './db.ts';
import { ensureConstraints } from './schema.ts';
import { loadSubgraph } from './write.ts';
import type { ArticleInput, LcdInput } from '../types.ts';

let graph: Graph;

async function cleanupTestData(): Promise<void> {
  await graph.run(`
    MATCH (n)
    WHERE n.id STARTS WITH 'TEST-W-' OR n.code STARTS WITH 'TEST-W-'
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
    id: 'TEST-W-L1',
    title: 'Test LCD',
    version: '1',
    sourceHash: 'TEST-W-hash-1',
    requirements: [
      { id: 'TEST-W-L1-R1', text: 'Requirement one', ordinal: 1, category: 'indication' },
      { id: 'TEST-W-L1-R2', text: 'Requirement two', ordinal: 2, category: 'documentation' },
    ],
    coveredCodes: [
      { system: 'TEST-W-HCPCS', code: 'TEST-W-E9819' },
      { system: 'TEST-W-HCPCS', code: 'TEST-W-A9801' },
    ],
    ...overrides,
  };
}

function articleFixture(overrides: Partial<ArticleInput> = {}): ArticleInput {
  return {
    id: 'TEST-W-A1',
    title: 'Test Article',
    version: '1',
    sourceHash: 'TEST-W-hash-a1',
    listedCodes: [
      { system: 'TEST-W-HCPCS', code: 'TEST-W-E9819' },
      { system: 'TEST-W-HCPCS', code: 'TEST-W-A9801' },
    ],
    denialReasons: [
      { id: 'TEST-W-A1-D1', text: 'Denial reason one' },
      { id: 'TEST-W-A1-D2', text: 'Denial reason two' },
    ],
    ...overrides,
  };
}

async function requiresCount(lcdId: string): Promise<number> {
  const rows = await graph.run(
    `MATCH (:LCD {id: $lcdId})-[:REQUIRES]->(r) RETURN count(r) AS count`,
    { lcdId },
  );
  return rows[0]?.count as number;
}

async function coversCount(lcdId: string): Promise<number> {
  const rows = await graph.run(
    `MATCH (:LCD {id: $lcdId})-[:COVERS]->(c) RETURN count(c) AS count`,
    { lcdId },
  );
  return rows[0]?.count as number;
}

test('loadSubgraph creates the full LCD + article graph shape with correct properties', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: lcdFixture(), article: articleFixture() });

  const [lcd] = await graph.run(`MATCH (lcd:LCD {id: $id}) RETURN properties(lcd) AS lcd`, { id: 'TEST-W-L1' });
  assert.ok(lcd, 'expected the LCD node to exist');
  const lcdProps = lcd?.lcd as Record<string, unknown>;
  assert.equal(lcdProps.status, 'draft');
  assert.equal(lcdProps.sourceHash, 'TEST-W-hash-1');
  assert.equal(lcdProps.title, 'Test LCD');
  assert.equal(lcdProps.version, '1');

  assert.equal(await requiresCount('TEST-W-L1'), 2);
  assert.equal(await coversCount('TEST-W-L1'), 2);

  const requirementRows = await graph.run(
    `MATCH (:LCD {id: $id})-[:REQUIRES]->(r:Requirement) RETURN properties(r) AS r ORDER BY r.ordinal`,
    { id: 'TEST-W-L1' },
  );
  assert.deepEqual(
    requirementRows.map((row) => row.r),
    [
      { id: 'TEST-W-L1-R1', text: 'Requirement one', ordinal: 1, category: 'indication' },
      { id: 'TEST-W-L1-R2', text: 'Requirement two', ordinal: 2, category: 'documentation' },
    ],
  );

  const [article] = await graph.run(
    `MATCH (:LCD {id: $lcdId})-[:HAS_ARTICLE]->(article:Article {id: $articleId}) RETURN article`,
    { lcdId: 'TEST-W-L1', articleId: 'TEST-W-A1' },
  );
  assert.ok(article, 'expected HAS_ARTICLE to link the LCD to its article');

  const [listsCount] = await graph.run(
    `MATCH (:Article {id: $id})-[:LISTS]->(c) RETURN count(c) AS count`,
    { id: 'TEST-W-A1' },
  );
  assert.equal(listsCount?.count, 2);

  const [definesCount] = await graph.run(
    `MATCH (:Article {id: $id})-[:DEFINES]->(d) RETURN count(d) AS count`,
    { id: 'TEST-W-A1' },
  );
  assert.equal(definesCount?.count, 2);
});

test('loadSubgraph is idempotent: reloading identical input creates no duplicates', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: lcdFixture(), article: articleFixture() });
  await loadSubgraph(graph, { lcd: lcdFixture(), article: articleFixture() });

  assert.equal(await requiresCount('TEST-W-L1'), 2);
  assert.equal(await coversCount('TEST-W-L1'), 2);

  const [requirementNodeCount] = await graph.run(
    `MATCH (r:Requirement) WHERE r.id STARTS WITH 'TEST-W-L1-' RETURN count(r) AS count`,
  );
  assert.equal(requirementNodeCount?.count, 2, 'must not create duplicate Requirement nodes');

  const [codeNodeCount] = await graph.run(
    `MATCH (c:Code) WHERE c.code STARTS WITH 'TEST-W-' RETURN count(c) AS count`,
  );
  assert.equal(codeNodeCount?.count, 2, 'must not create duplicate Code nodes');
});

test('loadSubgraph resets an approved LCD to draft when the source hash changes', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: lcdFixture() });
  await graph.run(`MATCH (lcd:LCD {id: $id}) SET lcd.status = 'approved'`, { id: 'TEST-W-L1' });

  await loadSubgraph(graph, { lcd: lcdFixture({ sourceHash: 'TEST-W-hash-2' }) });

  const [row] = await graph.run(`MATCH (lcd:LCD {id: $id}) RETURN lcd.status AS status, lcd.sourceHash AS sourceHash`, {
    id: 'TEST-W-L1',
  });
  assert.equal(row?.status, 'draft');
  assert.equal(row?.sourceHash, 'TEST-W-hash-2');
});

test('loadSubgraph leaves an approved LCD approved when the source hash is unchanged', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: lcdFixture() });
  await graph.run(`MATCH (lcd:LCD {id: $id}) SET lcd.status = 'approved'`, { id: 'TEST-W-L1' });

  await loadSubgraph(graph, { lcd: lcdFixture() }); // same sourceHash

  const [row] = await graph.run(`MATCH (lcd:LCD {id: $id}) RETURN lcd.status AS status`, { id: 'TEST-W-L1' });
  assert.equal(row?.status, 'approved');
});

test('loadSubgraph removes the REQUIRES edge for a requirement dropped from re-extraction', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: lcdFixture() });

  const trimmed = lcdFixture({
    requirements: [{ id: 'TEST-W-L1-R1', text: 'Requirement one', ordinal: 1, category: 'indication' }],
  });
  await loadSubgraph(graph, { lcd: trimmed });

  assert.equal(await requiresCount('TEST-W-L1'), 1);
  const [remaining] = await graph.run(
    `MATCH (:LCD {id: $id})-[:REQUIRES]->(r:Requirement) RETURN r.id AS id`,
    { id: 'TEST-W-L1' },
  );
  assert.equal(remaining?.id, 'TEST-W-L1-R1');

  // The dropped requirement's node itself is not deleted, only the edge.
  const [orphan] = await graph.run(`MATCH (r:Requirement {id: 'TEST-W-L1-R2'}) RETURN r`);
  assert.ok(orphan, 'the orphaned Requirement node should still exist');
});

function cignaLcdFixture(): LcdInput {
  return {
    id: 'TEST-W-CIG1',
    sourceHash: 'TEST-W-hash-cig',
    requirements: [{ id: 'TEST-W-CIG1-R1', text: 'Criterion.', ordinal: 1, category: 'indication' }],
    coveredCodes: [{ system: 'CPT', code: 'TEST-W-11111' }],
    denialReasons: [
      {
        id: 'TEST-W-CIG1-D1',
        text: 'Stand-alone removal is not medically necessary.',
        stance: 'not-medically-necessary',
        appliesTo: [{ system: 'CPT', code: 'TEST-W-22222' }],
      },
    ],
  };
}

test('an articleless LCD with denialReasons writes DEFINES from the LCD and APPLIES_TO to codes', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: cignaLcdFixture() });
  const rows = await graph.run(`
    MATCH (:LCD {id: 'TEST-W-CIG1'})-[:DEFINES]->(d:DenialReason)-[:APPLIES_TO]->(c:Code)
    RETURN d.id AS id, d.stance AS stance, c.code AS code
  `);
  assert.deepEqual(rows, [{ id: 'TEST-W-CIG1-D1', stance: 'not-medically-necessary', code: 'TEST-W-22222' }]);
});

test('re-loading with a changed denial set removes stale DEFINES and APPLIES_TO edges', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: cignaLcdFixture() });
  await loadSubgraph(graph, {
    lcd: {
      ...cignaLcdFixture(),
      denialReasons: [
        { id: 'TEST-W-CIG1-D2', text: 'Different reason.', stance: 'experimental-investigational', appliesTo: [] },
      ],
    },
  });
  const defines = await graph.run(`
    MATCH (:LCD {id: 'TEST-W-CIG1'})-[:DEFINES]->(d:DenialReason) RETURN d.id AS id ORDER BY id
  `);
  assert.deepEqual(defines, [{ id: 'TEST-W-CIG1-D2' }]);
  const applies = await graph.run(`
    MATCH (:DenialReason {id: 'TEST-W-CIG1-D1'})-[r:APPLIES_TO]->() RETURN count(r) AS n
  `);
  assert.equal(Number(applies[0]?.n ?? -1), 0);
});

test('re-loading with denialReasons absent removes all stale LCD-anchored denial edges', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: cignaLcdFixture() });
  const { denialReasons: _dropped, ...withoutDenials } = cignaLcdFixture();
  await loadSubgraph(graph, { lcd: withoutDenials });
  const defines = await graph.run(`
    MATCH (:LCD {id: 'TEST-W-CIG1'})-[r:DEFINES]->() RETURN count(r) AS n
  `);
  assert.equal(Number(defines[0]?.n ?? -1), 0);
  const applies = await graph.run(`
    MATCH (:DenialReason {id: 'TEST-W-CIG1-D1'})-[r:APPLIES_TO]->() RETURN count(r) AS n
  `);
  assert.equal(Number(applies[0]?.n ?? -1), 0);
});

test('loadSubgraph removes stale COVERS/LISTS/DEFINES edges when codes and denial reasons are dropped', async () => {
  await cleanupTestData();
  await loadSubgraph(graph, { lcd: lcdFixture(), article: articleFixture() });

  const trimmedLcd = lcdFixture({ coveredCodes: [{ system: 'TEST-W-HCPCS', code: 'TEST-W-E9819' }] });
  const trimmedArticle = articleFixture({
    listedCodes: [{ system: 'TEST-W-HCPCS', code: 'TEST-W-E9819' }],
    denialReasons: [{ id: 'TEST-W-A1-D1', text: 'Denial reason one' }],
  });
  await loadSubgraph(graph, { lcd: trimmedLcd, article: trimmedArticle });

  assert.equal(await coversCount('TEST-W-L1'), 1);

  const [listsCount] = await graph.run(
    `MATCH (:Article {id: $id})-[:LISTS]->(c) RETURN count(c) AS count`,
    { id: 'TEST-W-A1' },
  );
  assert.equal(listsCount?.count, 1);

  const [definesCount] = await graph.run(
    `MATCH (:Article {id: $id})-[:DEFINES]->(d) RETURN count(d) AS count`,
    { id: 'TEST-W-A1' },
  );
  assert.equal(definesCount?.count, 1);

  // Dropped Code/DenialReason nodes are not deleted, only the edges to them.
  const [orphanCode] = await graph.run(`MATCH (c:Code {system: 'TEST-W-HCPCS', code: 'TEST-W-A9801'}) RETURN c`);
  assert.ok(orphanCode, 'the orphaned Code node should still exist');
  const [orphanReason] = await graph.run(`MATCH (d:DenialReason {id: 'TEST-W-A1-D2'}) RETURN d`);
  assert.ok(orphanReason, 'the orphaned DenialReason node should still exist');
});
