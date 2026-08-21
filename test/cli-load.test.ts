import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { loadGraphConfig } from '../src/graph/config.ts';
import { createGraph } from '../src/graph/db.ts';
import type { Graph } from '../src/graph/db.ts';

const run = promisify(execFile);

const CLI = resolve(import.meta.dirname, '..', 'cli.ts');

// loadGraphConfig() reads .env (present at the repo root, which is this
// process's cwd) — do this once up front so the resulting values can ride
// into the CLI subprocess's env even though its cwd (a temp dir) has no
// .env of its own.
const config = loadGraphConfig();
const NEO4J_ENV = {
  NEO4J_URI: config.uri,
  NEO4J_USER: config.user,
  NEO4J_PASSWORD: config.password,
  NEO4J_DATABASE: config.database,
};

async function tempCwdWithFixtures(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-load-'));
  await mkdir(join(cwd, 'fixtures'), { recursive: true });
  return cwd;
}

function extractedSnapshot(lcdId: string) {
  return {
    lcdId,
    sourceHash: `${lcdId}-hash`,
    requirements: [
      { id: `${lcdId}-R1`, text: 'Requirement one', ordinal: 1, category: 'indication' },
      { id: `${lcdId}-R2`, text: 'Requirement two', ordinal: 2, category: 'documentation' },
    ],
    hcpcsCodes: [],
    warnings: [],
  };
}

function articleSnapshot(articleId: string) {
  return {
    id: articleId,
    sourceHash: `${articleId}-hash`,
    listedCodes: [{ system: 'TEST-C-HCPCS', code: 'TEST-C-E0607' }],
    denialReasons: [{ id: `${articleId}-D1`, text: 'Denial reason one' }],
  };
}

async function cleanup(graph: Graph): Promise<void> {
  await graph.run(`
    MATCH (n)
    WHERE n.id STARTS WITH 'TEST-C-' OR n.code STARTS WITH 'TEST-C-'
    DETACH DELETE n
  `);
}

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

async function runCli(args: readonly string[], cwd: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], { cwd, env: { ...process.env, ...NEO4J_ENV } });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

test('load reads a snapshot, loads it into the graph, and prints a validation report', async () => {
  const cwd = await tempCwdWithFixtures();
  const lcdId = 'TEST-C-L1';
  await writeFile(
    join(cwd, 'fixtures', `${lcdId}.extracted.json`),
    JSON.stringify(extractedSnapshot(lcdId), null, 2),
    'utf8',
  );

  const graph = createGraph(config);
  try {
    await cleanup(graph);

    const { stdout, code } = await runCli(['load', lcdId], cwd);

    const report: { clean: boolean; issues: { kind: string; detail: string }[] } = JSON.parse(stdout);
    assert.ok(Array.isArray(report.issues));
    // validateGraph runs over the whole shared database, so other data may
    // make the report unclean — assert only that our own load produced no
    // issues, and that the process's exit code matches the report.
    assert.ok(
      report.issues.every((issue) => !issue.detail.includes('TEST-C-')),
      `expected no TEST-C- issues, got: ${JSON.stringify(report.issues)}`,
    );
    assert.equal(code, report.clean ? 0 : 1);

    const [lcdRow] = await graph.run(`MATCH (lcd:LCD {id: $id}) RETURN lcd.status AS status`, { id: lcdId });
    assert.equal(lcdRow?.status, 'draft');

    const requirementRows = await graph.run(
      `MATCH (:LCD {id: $id})-[:REQUIRES]->(r:Requirement) RETURN r.id AS id ORDER BY r.ordinal`,
      { id: lcdId },
    );
    assert.deepEqual(
      requirementRows.map((row) => row.id),
      [`${lcdId}-R1`, `${lcdId}-R2`],
    );
  } finally {
    await cleanup(graph);
    await graph.close();
  }
});

test('load with an article id also loads the article, its listed codes, and denial reasons', async () => {
  const cwd = await tempCwdWithFixtures();
  const lcdId = 'TEST-C-L2';
  const articleId = 'TEST-C-A2';
  await writeFile(
    join(cwd, 'fixtures', `${lcdId}.extracted.json`),
    JSON.stringify(extractedSnapshot(lcdId), null, 2),
    'utf8',
  );
  await writeFile(
    join(cwd, 'fixtures', `${articleId}.article.json`),
    JSON.stringify(articleSnapshot(articleId), null, 2),
    'utf8',
  );

  const graph = createGraph(config);
  try {
    await cleanup(graph);

    await runCli(['load', lcdId, articleId], cwd); // exit code may be 1 due to unrelated shared-db issues; graph state is what we assert

    const [articleRow] = await graph.run(
      `MATCH (:LCD {id: $lcdId})-[:HAS_ARTICLE]->(article:Article {id: $articleId}) RETURN article`,
      { lcdId, articleId },
    );
    assert.ok(articleRow, 'expected HAS_ARTICLE to link the LCD to its article');

    const [listsCount] = await graph.run(`MATCH (:Article {id: $id})-[:LISTS]->(c) RETURN count(c) AS count`, {
      id: articleId,
    });
    assert.equal(listsCount?.count, 1);
  } finally {
    await cleanup(graph);
    await graph.close();
  }
});

test('load exits non-zero with an actionable message when the extraction snapshot is missing', async () => {
  const cwd = await tempCwdWithFixtures();

  const { code, stderr } = await runCli(['load', 'TEST-C-MISSING'], cwd);

  assert.equal(code, 1);
  assert.match(stderr, /fixtures\/TEST-C-MISSING\.extracted\.json/);
  assert.match(stderr, /node cli\.ts extract/);
});

test('load exits non-zero with an actionable message when the article snapshot is missing', async () => {
  const cwd = await tempCwdWithFixtures();
  const lcdId = 'TEST-C-L3';
  await writeFile(
    join(cwd, 'fixtures', `${lcdId}.extracted.json`),
    JSON.stringify(extractedSnapshot(lcdId), null, 2),
    'utf8',
  );

  const { code, stderr } = await runCli(['load', lcdId, 'TEST-C-MISSING-ARTICLE'], cwd);

  assert.equal(code, 1);
  assert.match(stderr, /fixtures\/TEST-C-MISSING-ARTICLE\.article\.json/);
});
