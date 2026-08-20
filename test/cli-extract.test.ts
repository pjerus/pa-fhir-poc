import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { stubOllama } from './support/stub-ollama.ts';

const run = promisify(execFile);

const CLI = resolve(import.meta.dirname, '..', 'cli.ts');
const SAMPLE_PDF = resolve(import.meta.dirname, 'fixtures', 'two-page-policy.pdf');

function queuedReplies(): () => string {
  const queue = [
    JSON.stringify({
      requirements: [
        { text: 'The patient must have a documented diagnosis.', category: 'indication' },
      ],
    }),
    JSON.stringify({
      requirements: [{ text: 'The treating order must be retained.', category: 'documentation' }],
    }),
  ];
  return () => queue.shift() ?? '{"requirements":[]}';
}

test('extract prints requirements and snapshots them beside the fixture', async () => {
  const nextReply = queuedReplies();
  const ollama = await stubOllama(() => ({ status: 200, payload: { response: nextReply() } }));
  const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-'));

  try {
    const { stdout } = await run('node', [CLI, 'extract', SAMPLE_PDF], {
      cwd,
      env: { ...process.env, OLLAMA_URL: ollama.baseUrl, EXTRACTION_MODEL: 'stub-model' },
    });

    const printed: unknown = JSON.parse(stdout);
    assert.ok(Array.isArray(printed));
    assert.equal(printed.length, 2);

    const snapshot: unknown = JSON.parse(
      await readFile(join(cwd, 'fixtures', 'two-page-policy.extracted.json'), 'utf8'),
    );
    assert.deepEqual(printed, (snapshot as { requirements: unknown }).requirements);
    assert.match((snapshot as { sourceHash: string }).sourceHash, /^[0-9a-f]{64}$/);
  } finally {
    await ollama.close();
  }
});

test('extract exits non-zero with an actionable message when the PDF is absent', async () => {
  const ollama = await stubOllama(() => ({ status: 200, payload: { response: '{}' } }));
  const cwd = await mkdtemp(join(tmpdir(), 'pa-fhir-poc-'));

  try {
    await assert.rejects(
      () =>
        run('node', [CLI, 'extract', 'fixtures/L00000.pdf'], {
          cwd,
          env: { ...process.env, OLLAMA_URL: ollama.baseUrl, EXTRACTION_MODEL: 'stub-model' },
        }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr ?? '', /fixtures\/L00000\.pdf/);
        assert.match(failure.stderr ?? '', /place/i);
        return true;
      },
    );
  } finally {
    await ollama.close();
  }
});
