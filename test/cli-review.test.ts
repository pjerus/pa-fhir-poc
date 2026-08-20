import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Client, Connection } from '@temporalio/client';

import { loadGraphConfig } from '../src/graph/config.ts';
import { loadTemporalConfig } from '../src/workflow/config.ts';
import { createGraph } from '../src/graph/db.ts';
import type { Graph } from '../src/graph/db.ts';

const run = promisify(execFile);

const CLI = resolve(import.meta.dirname, '..', 'cli.ts');

// loadGraphConfig()/loadTemporalConfig() read .env (present at the repo
// root, this process's cwd) — do this once up front so the resulting
// values can ride into the CLI subprocess's env even though its cwd (a
// temp dir) has no .env of its own.
const graphConfig = loadGraphConfig();
const NEO4J_ENV = {
  NEO4J_URI: graphConfig.uri,
  NEO4J_USER: graphConfig.user,
  NEO4J_PASSWORD: graphConfig.password,
  NEO4J_DATABASE: graphConfig.database,
};

const temporalConfig = loadTemporalConfig();
const TEMPORAL_ENV = {
  TEMPORAL_ADDRESS: temporalConfig.address,
  TEMPORAL_NAMESPACE: temporalConfig.namespace,
  TEMPORAL_TASK_QUEUE: temporalConfig.taskQueue,
};

const NAMESPACE = `TEST-C3-${process.pid}`;

async function tempCwdWithFixtures(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-review-'));
  await mkdir(join(cwd, 'fixtures'), { recursive: true });
  return cwd;
}

function extractedSnapshot(lcdId: string) {
  return {
    lcdId,
    sourceHash: `${lcdId}-hash`,
    requirements: [{ id: `${lcdId}-R1`, text: 'Requirement one', ordinal: 1, category: 'indication' }],
    warnings: [],
  };
}

async function cleanupGraph(graph: Graph): Promise<void> {
  await graph.run(`
    MATCH (n)
    WHERE n.id STARTS WITH '${NAMESPACE}' OR n.code STARTS WITH '${NAMESPACE}'
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
    const { stdout, stderr } = await run('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...NEO4J_ENV, ...TEMPORAL_ENV },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

async function terminateWorkflow(workflowId: string): Promise<void> {
  const connection = await Connection.connect({ address: temporalConfig.address });
  try {
    const client = new Client({ connection, namespace: temporalConfig.namespace });
    try {
      await client.workflow.getHandle(workflowId).terminate('test cleanup');
    } catch {
      // already terminated/never started — fine for cleanup.
    }
  } finally {
    await connection.close();
  }
}

test('review-start prints a workflow id for a workflow running on the server', async () => {
  const cwd = await tempCwdWithFixtures();
  const lcdId = `${NAMESPACE}-L1`;
  await writeFile(
    join(cwd, 'fixtures', `${lcdId}.extracted.json`),
    JSON.stringify(extractedSnapshot(lcdId), null, 2),
    'utf8',
  );

  const graph = createGraph(graphConfig);
  const connection = await Connection.connect({ address: temporalConfig.address });
  try {
    const { stdout, stderr, code } = await runCli(['review-start', lcdId], cwd);

    assert.equal(code, 0, `expected exit 0, stderr: ${stderr}`);
    const workflowId = stdout.trim();
    assert.equal(workflowId, `review-${lcdId}`);

    const client = new Client({ connection, namespace: temporalConfig.namespace });
    const description = await client.workflow.getHandle(workflowId).describe();
    assert.equal(description.status.name, 'RUNNING');
  } finally {
    await terminateWorkflow(`review-${lcdId}`);
    await cleanupGraph(graph);
    await connection.close();
    await graph.close();
  }
});

test('review-signal delivers a decision to a running review workflow', async () => {
  const cwd = await tempCwdWithFixtures();
  const lcdId = `${NAMESPACE}-L2`;
  await writeFile(
    join(cwd, 'fixtures', `${lcdId}.extracted.json`),
    JSON.stringify(extractedSnapshot(lcdId), null, 2),
    'utf8',
  );

  const graph = createGraph(graphConfig);
  try {
    const started = await runCli(['review-start', lcdId], cwd);
    assert.equal(started.code, 0, `expected review-start exit 0, stderr: ${started.stderr}`);
    const workflowId = started.stdout.trim();

    const { code, stderr } = await runCli(['review-signal', workflowId, 'approve', 'Dr. Test'], cwd);

    assert.equal(code, 0, `expected exit 0, stderr: ${stderr}`);
  } finally {
    await terminateWorkflow(`review-${lcdId}`);
    await cleanupGraph(graph);
    await graph.close();
  }
});

test('review-start exits non-zero with an actionable message when the extraction snapshot is missing', async () => {
  const cwd = await tempCwdWithFixtures();

  const { code, stderr } = await runCli(['review-start', `${NAMESPACE}-MISSING`], cwd);

  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`fixtures/${NAMESPACE}-MISSING\\.extracted\\.json`));
  assert.match(stderr, /node cli\.ts extract/);
});

test('review-signal exits non-zero with an actionable message when the decision is not approve|reject', async () => {
  const cwd = await tempCwdWithFixtures();

  const { code, stderr } = await runCli(['review-signal', 'review-does-not-matter', 'maybe', 'Dr. Test'], cwd);

  assert.equal(code, 1);
  assert.match(stderr, /approve/);
  assert.match(stderr, /reject/);
});
