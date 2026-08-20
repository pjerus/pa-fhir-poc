import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CLI = resolve(import.meta.dirname, '..', 'cli.ts');

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

  await t.test('exits non-zero with usage when only one arg is given', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-run-'));

    const { code, stderr } = await runCli(['run', 'lcd.pdf'], cwd);
    assert.equal(code, 1);
    assert.match(stderr, /Usage/);
  });

  await t.test('exits non-zero naming the exact missing LCD path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-run-'));
    const lcdPath = join(cwd, 'missing-lcd.pdf');
    const articlePath = join(cwd, 'missing-article.pdf');

    const { code, stderr } = await runCli(['run', lcdPath, articlePath], cwd);
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(lcdPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  await t.test('checks the LCD path before the article path, and does not attempt to parse', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-run-'));
    const lcdPath = join(cwd, 'lcd.pdf');
    const articlePath = join(cwd, 'missing-article.pdf');
    await writeFile(lcdPath, 'not a real pdf', 'utf8');

    const { code, stderr } = await runCli(['run', lcdPath, articlePath], cwd);
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(articlePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(stderr, /parse|extract failed|Invalid PDF/i);
  });

  await t.test('usage text includes the run verb', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-run-'));

    const { stderr } = await runCli(['run'], cwd);
    assert.match(stderr, /run <lcd\.pdf>/);
  });
});
