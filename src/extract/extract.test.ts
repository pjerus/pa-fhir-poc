import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeLlm } from '../../test/support/fake-llm.ts';
import { extractPdfText } from './pdf-text.ts';
import { extractLcd } from './extract.ts';

const SAMPLE_PDF = 'test/fixtures/two-page-policy.pdf';
const CIGNA_SAMPLE_PDF = 'test/fixtures/CIGNA-0101.pdf';

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

function cignaReplies(): string[] {
  // One combined indications+limitations block => one LLM call.
  return [
    JSON.stringify({
      requirements: [
        { text: 'Widget therapy requires a documented diagnosis of testitis.', category: 'indication' },
        { text: 'Widget removal as a stand-alone procedure is not medically necessary.', category: 'limitation' },
      ],
    }),
  ];
}

test('extractLcd dispatches the Cigna dialect end to end', async () => {
  const result = await extractLcd(CIGNA_SAMPLE_PDF, fakeLlm(cignaReplies()));
  assert.equal(result.dialect, 'cigna');
  assert.equal(result.lcdId, 'CIGNA-0101');
  assert.deepEqual(result.hcpcsCodes, [
    { system: 'CPT', code: '12345' },
    { system: 'HCPCS', code: 'A1234' },
  ]);
  assert.equal(result.denialReasons?.length, 2);
  assert.equal(result.denialReasons?.[0]?.stance, 'not-medically-necessary');
  assert.deepEqual(result.denialReasons?.[0]?.appliesTo, [{ system: 'CPT', code: '23456' }]);
  assert.equal(result.requirements.length, 2);
});

test('extractLcd keeps the MAC path: dialect recorded, no denialReasons', async () => {
  const result = await extractLcd(SAMPLE_PDF, fakeLlm(replies()));
  assert.equal(result.dialect, 'mac');
  assert.equal(result.denialReasons, undefined);
});

test('extractLcd fails loud on a filename/document id mismatch', async () => {
  // CIGNA-0101.pdf copied under a wrong name must be rejected at intake.
  const dir = await mkdtemp(join(tmpdir(), 'extract-idcheck-'));
  const wrongName = join(dir, 'CIGNA-0999.pdf');
  await copyFile(CIGNA_SAMPLE_PDF, wrongName);
  await assert.rejects(() => extractLcd(wrongName, fakeLlm(cignaReplies())), /CIGNA-0101/);
});
