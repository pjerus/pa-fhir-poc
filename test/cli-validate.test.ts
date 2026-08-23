import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

// Only the deterministic surface: nothing here runs Docker or the validator.
test('validate', async (t) => {
  await t.test('exits non-zero with usage when no LCD id is given', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-validate-'));

    const { code, stderr } = await runCli(['validate'], cwd);
    assert.equal(code, 1);
    assert.match(stderr, /Usage/);
  });

  await t.test('without the validator jar, fails naming the fetch script', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-validate-'));

    const { code, stderr } = await runCli(['validate', 'L99999'], cwd);
    assert.equal(code, 1);
    assert.match(stderr, /tools\/fetch-validator\.sh/);
  });

  await t.test('with the jar but no projected artifacts, fails naming the project command', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-validate-'));
    await mkdir(join(cwd, 'tools'), { recursive: true });
    await writeFile(join(cwd, 'tools', 'validator_cli.jar'), 'placeholder', 'utf8');

    const { code, stderr } = await runCli(['validate', 'L99999'], cwd);
    assert.equal(code, 1);
    assert.match(stderr, /node cli\.ts project L99999/);
    // The PlanDefinition is projected for every policy, so its absence is the
    // loud never-projected signal (a missing dtr.json alone is a legitimate
    // skip for zero-documentation policies).
    assert.match(stderr, /L99999\.plandefinition\.json/);
  });
});
