import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { fakeLlm } from '../../test/support/fake-llm.ts';
import { extractPdfText } from './pdf-text.ts';
import { extractLcd } from './extract.ts';

const SAMPLE_PDF = 'test/fixtures/two-page-policy.pdf';

function replies(): string[] {
  return [
    JSON.stringify({
      requirements: [
        { text: 'The patient must have a documented diagnosis.', category: 'indication' },
      ],
    }),
    JSON.stringify({
      requirements: [{ text: 'The treating order must be retained.', category: 'documentation' }],
    }),
  ];
}

test('derives the LCD id from the fixture filename', async () => {
  const result = await extractLcd(SAMPLE_PDF, fakeLlm(replies()));

  assert.equal(result.lcdId, 'two-page-policy');
});

test('hashes the extracted source text so a changed PDF is detectable', async () => {
  const { text } = await extractPdfText(SAMPLE_PDF);
  const expected = createHash('sha256').update(text, 'utf8').digest('hex');

  const result = await extractLcd(SAMPLE_PDF, fakeLlm(replies()));

  assert.equal(result.sourceHash, expected);
});

test('carries requirements and section warnings through to the result', async () => {
  const result = await extractLcd(SAMPLE_PDF, fakeLlm(replies()));

  assert.deepEqual(
    result.requirements.map((requirement) => requirement.id),
    ['two-page-policy-R1', 'two-page-policy-R2'],
  );
  assert.deepEqual(result.warnings, [
    'No "limitations" heading found; downstream extraction will skip that section.',
    'No "CPT/HCPCS Codes" heading found; recording an empty list rather than a stub.',
  ]);
  assert.deepEqual(result.hcpcsCodes, []);
});
