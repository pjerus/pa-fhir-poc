import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CLI = resolve(import.meta.dirname, '..', 'cli.ts');
const MAC_PDF = resolve(import.meta.dirname, 'fixtures', 'two-page-policy.pdf');
const CIGNA_PDF = resolve(import.meta.dirname, 'fixtures', 'CIGNA-0101.pdf');

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

async function runCli(args: readonly string[], cwd: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], { cwd, env: { ...process.env } });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

test('run', async (t) => {
  await t.test('exits non-zero with usage when no args are given', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-run-'));

    const { code, stderr } = await runCli(['run'], cwd);
    assert.equal(code, 1);
    assert.match(stderr, /Usage/);
  });

  await t.test('exits non-zero naming the missing policy PDF when only one arg is given', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-run-'));

    const { code, stderr } = await runCli(['run', 'lcd.pdf'], cwd);
    assert.equal(code, 1);
    assert.match(stderr, /lcd\.pdf/);
    assert.match(stderr, /not found/i);
  });

  await t.test('exits non-zero naming the exact missing LCD path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-run-'));
    const lcdPath = join(cwd, 'missing-lcd.pdf');
    const articlePath = join(cwd, 'missing-article.pdf');

    const { code, stderr } = await runCli(['run', lcdPath, articlePath], cwd);
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(lcdPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  await t.test('checks the article path only after a real policy PDF sniffs its dialect', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-run-'));
    const articlePath = join(cwd, 'missing-article.pdf');

    const { code, stderr } = await runCli(['run', MAC_PDF, articlePath], cwd);
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(articlePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(stderr, /extract failed/i);
  });

  await t.test('usage text includes the run verb', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-run-'));

    const { stderr } = await runCli(['run'], cwd);
    assert.match(stderr, /run <policy\.pdf>/);
  });

  await t.test('run with a MAC policy and no article fails loud naming the article requirement', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-run-'));

    const { code, stderr } = await runCli(['run', MAC_PDF], cwd);
    assert.equal(code, 1);
    assert.match(stderr, /article/i);
    assert.match(stderr, /mac/i);
  });

  await t.test('run with a Cigna policy and an article fails loud as single-document', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-run-'));

    const { code, stderr } = await runCli(['run', CIGNA_PDF, MAC_PDF], cwd);
    assert.equal(code, 1);
    assert.match(stderr, /single-document/i);
  });
});
