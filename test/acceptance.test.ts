import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { extractLcd } from '../src/extract/extract.ts';
import { createOllamaClient } from '../src/extract/llm-client.ts';
import { checkAgainstExpected, parseExpected } from './support/expected.ts';

const FIXTURES_DIR = 'fixtures';
const EXPECTED_SUFFIX = '.expected.json';
/** A 27B model reading a full coverage policy is slow; this is a ceiling, not a target. */
const EXTRACTION_TIMEOUT_MS = 900_000;

const entries = await readdir(FIXTURES_DIR).catch(() => [] as string[]);
const lcdIds = entries
  .filter((entry) => entry.endsWith(EXPECTED_SUFFIX))
  .map((entry) => entry.slice(0, -EXPECTED_SUFFIX.length))
  .sort();

if (lcdIds.length === 0) {
  test('extraction matches hand-authored ground truth', {
    skip:
      `no ${FIXTURES_DIR}/<lcdId>${EXPECTED_SUFFIX} found. This is M1's acceptance gate and it ` +
      'has not run. Place the Medicare Coverage Database "Create PDF" export at ' +
      `${FIXTURES_DIR}/<lcdId>.pdf and hand-author ${FIXTURES_DIR}/<lcdId>${EXPECTED_SUFFIX}.`,
  }, () => {});
}

for (const lcdId of lcdIds) {
  const pdfPath = join(FIXTURES_DIR, `${lcdId}.pdf`);
  const hasPdf = await access(pdfPath).then(() => true, () => false);

  test(
    `extraction of ${lcdId} matches its ground truth`,
    {
      timeout: EXTRACTION_TIMEOUT_MS,
      skip: hasPdf
        ? false
        : `${pdfPath} missing. Committed fixtures should always be present; fetch-gated fixtures ` +
          '(copyrighted sources, e.g. CIGNA-0158) are downloaded by their tools/fetch-*.sh script.',
    },
    async () => {
      const expectedPath = join(FIXTURES_DIR, `${lcdId}${EXPECTED_SUFFIX}`);
      const expected = parseExpected(
        JSON.parse(await readFile(expectedPath, 'utf8')) as unknown,
        expectedPath,
      );

      const llm = createOllamaClient({
        baseUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
        model: process.env.EXTRACTION_MODEL ?? 'qwen3.8:27b',
      });

      const { requirements } = await extractLcd(join(FIXTURES_DIR, `${lcdId}.pdf`), llm);
      const failures = checkAgainstExpected(requirements, expected);

      assert.deepEqual(
        failures,
        [],
        `extraction of ${lcdId} did not match ${expectedPath}:\n` +
          `${failures.map((failure) => `  - ${failure}`).join('\n')}\n\n` +
          'This gate asserts structure, never prose. Do not loosen it to make it pass — ' +
          'a miss here is a finding about the local model.\n' +
          `Extracted:\n${JSON.stringify(requirements, null, 2)}`,
      );
    },
  );
}
