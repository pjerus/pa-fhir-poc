import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { loadGraphConfig } from './config.ts';
import { createGraph } from './db.ts';
import type { Graph } from './db.ts';
import { ensureConstraints } from './schema.ts';
import { loadSubgraph } from './write.ts';
import { validateGraph } from './validate.ts';
import type { IssueKind, ValidationIssue } from './validate.ts';
import type { ArticleInput, LcdInput } from '../types.ts';

let graph: Graph;

// Scoped to this file's own 'TEST-V-' namespace (not the bare 'TEST-' prefix
// write.test.ts uses) so this file's cleanup never deletes write.test.ts's
// in-flight fixtures when both integration test files run concurrently under
// node --test's default cross-file parallelism.
async function cleanupTestData(): Promise<void> {
  await graph.run(`
    MATCH (n)
    WHERE n.id STARTS WITH 'TEST-V-' OR n.code STARTS WITH 'TEST-V-'
    DETACH DELETE n
  `);
}

/**
 * Runs one test's body and cleans up immediately afterward (success or
 * failure), rather than deferring cleanup to the next test's setup. This
 * file's synthetic Code nodes carry codes prefixed 'TEST-...' (per the
 * project convention), which also match write.test.ts's own blanket
 * `code STARTS WITH 'TEST-'` counts — leaving them around any longer than
 * this test's own body would pollute those counts when both files run
 * concurrently under node --test's default cross-file parallelism.
 */
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
    id: 'TEST-V-L1',
    title: 'Test LCD',
    version: '1',
    sourceHash: 'TEST-V-hash-1',
    requirements: [
      { id: 'TEST-V-L1-R1', text: 'Requirement one', ordinal: 1, category: 'indication' },
      { id: 'TEST-V-L1-R2', text: 'Requirement two', ordinal: 2, category: 'documentation' },
    ],
    coveredCodes: [
      { system: 'TEST-V-HCPCS', code: 'TEST-V-E0607' },
      { system: 'TEST-V-HCPCS', code: 'TEST-V-A4253' },
    ],
    ...overrides,
  };
}

function articleFixture(overrides: Partial<ArticleInput> = {}): ArticleInput {
  return {
    id: 'TEST-V-A1',
    title: 'Test Article',
    version: '1',
    sourceHash: 'TEST-V-hash-a1',
    listedCodes: [
      { system: 'TEST-V-HCPCS', code: 'TEST-V-E0607' },
      { system: 'TEST-V-HCPCS', code: 'TEST-V-A4253' },
    ],
    denialReasons: [
      { id: 'TEST-V-A1-D1', text: 'Denial reason one' },
      { id: 'TEST-V-A1-D2', text: 'Denial reason two' },
    ],
    ...overrides,
  };
}

function issuesOfKind(issues: readonly ValidationIssue[], kind: IssueKind): ValidationIssue[] {
  return issues.filter((issue) => issue.kind === kind);
}

function testIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return issues.filter((issue) => issue.detail.includes('TEST-'));
}

isolated('validateGraph reports the clean/issues invariant and no TEST- defects for a well-formed graph', async () => {
  await loadSubgraph(graph, { lcd: lcdFixture(), article: articleFixture() });

  const report = await validateGraph(graph);

  assert.equal(report.clean, report.issues.length === 0, 'clean must equal issues.length === 0');
  assert.equal(testIssues(report.issues).length, 0, 'a well-formed fixture graph should raise no TEST- issues');
});

isolated('validateGraph detects duplicate-requirement-text within the same LCD', async () => {
  await loadSubgraph(graph, { lcd: lcdFixture(), article: articleFixture() });
  await graph.run(`
    MATCH (lcd:LCD {id: 'TEST-V-L1'})
    CREATE (r:Requirement {id: 'TEST-V-L1-R3', text: 'Requirement one', ordinal: 3, category: 'indication'})
    MERGE (lcd)-[:REQUIRES]->(r)
  `);

  const report = await validateGraph(graph);

  const matches = issuesOfKind(report.issues, 'duplicate-requirement-text').filter(
    (issue) => issue.detail.includes('TEST-V-L1-R1') && issue.detail.includes('TEST-V-L1-R3'),
  );
  assert.equal(matches.length, 1, `expected a duplicate-requirement-text issue naming both ids, got: ${JSON.stringify(report.issues)}`);
  assert.equal(report.clean, report.issues.length === 0);
});

isolated('validateGraph detects an orphan Code with no incoming COVERS or LISTS', async () => {
  await graph.run(`CREATE (c:Code {system: 'TEST-V-HCPCS', code: 'TEST-V-ORPHAN'})`);

  const report = await validateGraph(graph);

  const matches = issuesOfKind(report.issues, 'orphan-code').filter((issue) => issue.detail.includes('TEST-V-ORPHAN'));
  assert.equal(matches.length, 1, `expected an orphan-code issue naming TEST-V-ORPHAN, got: ${JSON.stringify(report.issues)}`);
  assert.equal(report.clean, report.issues.length === 0);
});

isolated('validateGraph detects an orphan DenialReason with no incoming DEFINES', async () => {
  await graph.run(`CREATE (d:DenialReason {id: 'TEST-V-D-ORPHAN', text: 'orphan reason'})`);

  const report = await validateGraph(graph);

  const matches = issuesOfKind(report.issues, 'orphan-denial-reason').filter((issue) =>
    issue.detail.includes('TEST-V-D-ORPHAN'),
  );
  assert.equal(matches.length, 1, `expected an orphan-denial-reason issue naming TEST-V-D-ORPHAN, got: ${JSON.stringify(report.issues)}`);
  assert.equal(report.clean, report.issues.length === 0);
});

isolated('validateGraph detects a Requirement self-loop cycle', async () => {
  await loadSubgraph(graph, { lcd: lcdFixture() });
  await graph.run(`
    MATCH (r:Requirement {id: 'TEST-V-L1-R1'})
    CREATE (r)-[:DEPENDS_ON]->(r)
  `);

  const report = await validateGraph(graph);

  const matches = issuesOfKind(report.issues, 'requirement-cycle').filter((issue) =>
    issue.detail.includes('TEST-V-L1-R1'),
  );
  assert.ok(matches.length >= 1, `expected a requirement-cycle issue naming TEST-V-L1-R1, got: ${JSON.stringify(report.issues)}`);
  assert.equal(report.clean, report.issues.length === 0);
});

isolated('validateGraph detects a length-2 Requirement cycle over an arbitrary relationship type', async () => {
  await graph.run(`
    CREATE (a:Requirement {id: 'TEST-V-CYCLE-A', text: 'a', ordinal: 1, category: 'indication'})
    CREATE (b:Requirement {id: 'TEST-V-CYCLE-B', text: 'b', ordinal: 2, category: 'indication'})
    CREATE (a)-[:DEPENDS_ON]->(b)
    CREATE (b)-[:DEPENDS_ON]->(a)
  `);

  const report = await validateGraph(graph);

  const matches = issuesOfKind(report.issues, 'requirement-cycle').filter(
    (issue) => issue.detail.includes('TEST-V-CYCLE-A') && issue.detail.includes('TEST-V-CYCLE-B'),
  );
  assert.ok(
    matches.length >= 1,
    `expected a requirement-cycle issue naming TEST-V-CYCLE-A and TEST-V-CYCLE-B, got: ${JSON.stringify(report.issues)}`,
  );
  assert.equal(report.clean, report.issues.length === 0);
});

isolated('validateGraph detects duplicate-code-pair for two Code nodes sharing (system, code)', async () => {
  await graph.run(`
    CREATE (:Code {system: 'TEST-V-DUPSYS', code: 'TEST-V-DUPCODE'})
    CREATE (:Code {system: 'TEST-V-DUPSYS', code: 'TEST-V-DUPCODE'})
  `);

  const report = await validateGraph(graph);

  const matches = issuesOfKind(report.issues, 'duplicate-code-pair').filter(
    (issue) => issue.detail.includes('TEST-V-DUPSYS') && issue.detail.includes('TEST-V-DUPCODE'),
  );
  assert.equal(matches.length, 1, `expected a duplicate-code-pair issue naming TEST-V-DUPSYS/TEST-V-DUPCODE, got: ${JSON.stringify(report.issues)}`);
  assert.equal(report.clean, report.issues.length === 0);
});
