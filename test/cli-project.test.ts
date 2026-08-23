import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { loadGraphConfig } from '../src/graph/config.ts';
import { createGraph } from '../src/graph/db.ts';
import type { Graph } from '../src/graph/db.ts';
import { ensureConstraints } from '../src/graph/schema.ts';
import { loadSubgraph } from '../src/graph/write.ts';
import type { LoadSubgraphInput } from '../src/graph/write.ts';
import type { ApprovedSubgraph } from '../src/graph/read.ts';
import { syntheticSubgraph } from '../src/fhir/test-support.ts';
import { DTR_STD_QUESTIONNAIRE_PROFILE } from '../src/fhir/profiles.ts';

const run = promisify(execFile);

const CLI = resolve(import.meta.dirname, '..', 'cli.ts');

const config = loadGraphConfig();
const NEO4J_ENV = {
  NEO4J_URI: config.uri,
  NEO4J_USER: config.user,
  NEO4J_PASSWORD: config.password,
  NEO4J_DATABASE: config.database,
};

function toLoadInput(subgraph: ApprovedSubgraph): LoadSubgraphInput {
  const { lcd, requirements, coveredCodes, article, denialReasons } = subgraph;
  return {
    lcd: {
      id: lcd.id,
      ...(lcd.title !== undefined ? { title: lcd.title } : {}),
      ...(lcd.version !== undefined ? { version: lcd.version } : {}),
      sourceHash: lcd.sourceHash,
      requirements,
      coveredCodes,
    },
    ...(article !== undefined
      ? {
          article: {
            ...article,
            denialReasons: denialReasons.map(({ id, text, stance }) =>
              stance !== undefined ? { id, text, stance } : { id, text },
            ),
          },
        }
      : {}),
  };
}

async function approve(graph: Graph, lcdId: string): Promise<void> {
  await graph.run(`MATCH (l:LCD {id: $id}) SET l.status = 'approved'`, { id: lcdId });
}

async function cleanup(graph: Graph): Promise<void> {
  await graph.run(`
    MATCH (n)
    WHERE n.id STARTS WITH 'TEST-P-' OR n.code STARTS WITH 'TEST-P-'
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

test('project', async (t) => {
  const graph = createGraph(config);
  await cleanup(graph);
  await ensureConstraints(graph);

  await loadSubgraph(graph, toLoadInput(syntheticSubgraph()));
  await approve(graph, 'TEST-P-LCD1');

  const draftSubgraph: ApprovedSubgraph = {
    lcd: { id: 'TEST-P-LCD2', status: 'draft', sourceHash: 'hash-lcd2' },
    requirements: [],
    coveredCodes: [],
    denialReasons: [],
  };
  await loadSubgraph(graph, toLoadInput(draftSubgraph));
  // TEST-P-LCD2 stays draft — deliberately not approved.

  t.after(async () => {
    await cleanup(graph);
    await graph.close();
  });

  await t.test('emits CRD/DTR/PlanDefinition artifacts for an approved LCD', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-project-'));

    const { code } = await runCli(['project', 'TEST-P-LCD1'], cwd);
    assert.equal(code, 0);

    const crd: { cards: unknown[] } = JSON.parse(await readFile(join(cwd, 'out', 'TEST-P-LCD1.crd.json'), 'utf8'));
    assert.equal(crd.cards.length, 1);

    const dtr: { resourceType: string; meta?: { profile?: string[] } } = JSON.parse(
      await readFile(join(cwd, 'out', 'TEST-P-LCD1.dtr.json'), 'utf8'),
    );
    assert.equal(dtr.resourceType, 'Questionnaire');
    assert.ok(dtr.meta?.profile?.includes(DTR_STD_QUESTIONNAIRE_PROFILE));

    const planDefinition: { action: unknown[] } = JSON.parse(
      await readFile(join(cwd, 'out', 'TEST-P-LCD1.plandefinition.json'), 'utf8'),
    );
    assert.equal(planDefinition.action.length, 2);
  });

  await t.test('exits non-zero with an actionable message when the LCD is still draft', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-project-'));

    const { code, stderr } = await runCli(['project', 'TEST-P-LCD2'], cwd);
    assert.equal(code, 1);
    assert.match(stderr, /draft/);
  });

  await t.test('exits non-zero with an actionable message when the LCD is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-project-'));

    const { code, stderr } = await runCli(['project', 'TEST-P-NOPE'], cwd);
    assert.equal(code, 1);
    assert.match(stderr, /TEST-P-NOPE/);
    assert.match(stderr, /node cli\.ts load/);
  });

  await t.test('exits non-zero with usage when no lcdId is given', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-project-'));

    const { code, stderr } = await runCli(['project'], cwd);
    assert.equal(code, 1);
    assert.match(stderr, /Usage/);
  });
});
