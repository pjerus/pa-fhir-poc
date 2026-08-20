import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CLI = resolve(import.meta.dirname, '..', 'cli.ts');

test('extract-article exits non-zero with an actionable message when the PDF is absent', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-'));

  await assert.rejects(
    () => run('node', [CLI, 'extract-article', 'fixtures/A00000.pdf'], { cwd }),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? '', /fixtures\/A00000\.pdf/);
      assert.match(failure.stderr ?? '', /place/i);
      return true;
    },
  );
});
