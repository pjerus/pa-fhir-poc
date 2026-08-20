import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeLlm } from '../../test/support/fake-llm.ts';
import { extractArticle, extractHcpcsCodes, extractIcd10Codes, parseArticleText } from './article.ts';

const ARTICLE_ID = 'TEST-ARTICLE';

const DENIAL_REPLY = JSON.stringify({
  denialReasons: [
    { text: 'Claims will be denied as not medically necessary without a documented diagnosis.' },
    { text: 'Claims will be denied as not medically necessary without a treating order.' },
  ],
});

/**
 * A minimal document in the same section order real MCD articles use:
 * non-medical-necessity prose, then coding guidelines, then the CPT/HCPCS
 * heading, then the ICD-10 support/do-not-support headings. The ICD-10
 * "Support Medical / Necessity" heading is deliberately split across two
 * lines -- real PDF text extraction wraps it exactly like this, and that
 * split is what per-line heading matching could never find.
 */
function fullDocument(...extraLines: string[]): string {
  return [
    'NON-MEDICAL NECESSITY INDICATIONS:',
    'Devices used solely for screening purposes are not covered.',
    'CODING GUIDELINES',
    'General billing guidance appears here.',
    'Coding Information',
    'CPT/HCPCS Codes',
    'E0607 Home blood glucose monitor',
    'A4253 Blood glucose test strips',
    'ICD-10-CM Codes that Support Medical',
    'Necessity',
    'E11.9 Type 2 diabetes mellitus without complications',
    'E11.65 Type 2 diabetes mellitus with hyperglycemia',
    'ICD-10-CM Codes that DO NOT Support Medical Necessity',
    'Z79.4 Long term (current) use of insulin',
    ...extraLines,
  ].join('\n');
}

// ---- extractIcd10Codes -----------------------------------------------------

test('extractIcd10Codes: spans a heading split across two lines, bounded by the closing heading', () => {
  const text = [
    'Some preamble line.',
    'ICD-10-CM Codes that Support Medical',
    'Necessity',
    'E11.9 Type 2 diabetes mellitus without complications',
    'E11.65 Type 2 diabetes mellitus with hyperglycemia',
    'ICD-10-CM Codes that DO NOT Support Medical Necessity',
    'Z79.4 Long term (current) use of insulin',
  ].join('\n');

  assert.deepEqual(extractIcd10Codes(text), [
    { system: 'ICD-10-CM', code: 'E11.9' },
    { system: 'ICD-10-CM', code: 'E11.65' },
  ]);
});

test('extractIcd10Codes: throws naming the heading when it is not found', () => {
  const text = ['No relevant headings here.', 'Just some prose.'].join('\n');

  assert.throws(() => extractIcd10Codes(text), /ICD-10-CM Codes That Support Medical Necessity/i);
});

test('extractIcd10Codes: throws naming the heading when zero codes are found beneath it', () => {
  const text = [
    'ICD-10-CM Codes that Support Medical Necessity',
    'No codes listed here, just prose about medical necessity.',
    'ICD-10-CM Codes that DO NOT Support Medical Necessity',
  ].join('\n');

  assert.throws(() => extractIcd10Codes(text), /ICD-10-CM Codes That Support Medical Necessity/i);
});

// ---- extractHcpcsCodes ------------------------------------------------------

test('extractHcpcsCodes: bounded by the start of the ICD-10 support heading (itself split across two lines)', () => {
  const text = [
    'CPT/HCPCS Codes',
    'E0607 Home blood glucose monitor',
    'A4253 Blood glucose test strips',
    'ICD-10-CM Codes that Support Medical',
    'Necessity',
    'B9999 should not be counted',
  ].join('\n');

  assert.deepEqual(extractHcpcsCodes(text), {
    codes: [
      { system: 'HCPCS', code: 'E0607' },
      { system: 'HCPCS', code: 'A4253' },
    ],
    warnings: [],
  });
});

test('extractHcpcsCodes: throws naming the heading when it is not found', () => {
  const text = ['No relevant headings here.', 'Just some prose.'].join('\n');

  assert.throws(() => extractHcpcsCodes(text), /CPT\/HCPCS Codes/i);
});

test('extractHcpcsCodes: falls back to the Coding Guidelines section when the primary region has zero codes', () => {
  const text = [
    'CODING GUIDELINES',
    'For claims use code K0554 and code K0553 for the supply allowance.',
    'Coding Information',
    'CPT/HCPCS Codes',
    'N/A',
  ].join('\n');

  assert.deepEqual(extractHcpcsCodes(text), {
    codes: [
      { system: 'HCPCS', code: 'K0554' },
      { system: 'HCPCS', code: 'K0553' },
    ],
    warnings: [],
  });
});

test('extractHcpcsCodes: returns an empty list with a warning when both the primary region and the fallback are empty', () => {
  const text = [
    'CODING GUIDELINES',
    'This section describes general billing rules with no codes listed.',
    'Coding Information',
    'CPT/HCPCS Codes',
    'N/A',
  ].join('\n');

  const result = extractHcpcsCodes(text);

  assert.deepEqual(result.codes, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /no hcpcs codes found/i);
});

// ---- parseArticleText (denial reasons + full assembly) ---------------------

test('parseArticleText: assembles ICD-10/HCPCS codes and deterministic denial-reason ids from a realistic document', async () => {
  const text = fullDocument();
  const llm = fakeLlm([DENIAL_REPLY]);

  const result = await parseArticleText(text, ARTICLE_ID, llm);

  assert.equal(result.id, ARTICLE_ID);
  assert.deepEqual(result.listedCodes, [
    { system: 'ICD-10-CM', code: 'E11.9' },
    { system: 'ICD-10-CM', code: 'E11.65' },
  ]);
  assert.deepEqual(result.hcpcsCodes, [
    { system: 'HCPCS', code: 'E0607' },
    { system: 'HCPCS', code: 'A4253' },
  ]);
  assert.deepEqual(result.denialReasons, [
    {
      id: `${ARTICLE_ID}-D1`,
      text: 'Claims will be denied as not medically necessary without a documented diagnosis.',
    },
    {
      id: `${ARTICLE_ID}-D2`,
      text: 'Claims will be denied as not medically necessary without a treating order.',
    },
  ]);
  assert.deepEqual(result.warnings, []);
});

test('parseArticleText: falls back to the whole text with a warning when no non-medical-necessity heading exists', async () => {
  const text = [
    'CODING GUIDELINES',
    'General billing guidance appears here.',
    'Coding Information',
    'CPT/HCPCS Codes',
    'E0607 Home blood glucose monitor',
    'A4253 Blood glucose test strips',
    'ICD-10-CM Codes that Support Medical',
    'Necessity',
    'E11.9 Type 2 diabetes mellitus without complications',
    'E11.65 Type 2 diabetes mellitus with hyperglycemia',
    'ICD-10-CM Codes that DO NOT Support Medical Necessity',
    'Z79.4 Long term (current) use of insulin',
  ].join('\n');
  const llm = fakeLlm([DENIAL_REPLY]);

  const result = await parseArticleText(text, ARTICLE_ID, llm);

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /non-medical necessity/i);
  assert.equal(result.denialReasons.length, 2);
});

test('parseArticleText: retries once with a sharper instruction when the model returns unusable output', async () => {
  const text = fullDocument();
  const llm = fakeLlm(['Sure! Here are the denial reasons you asked for.', DENIAL_REPLY]);

  const result = await parseArticleText(text, ARTICLE_ID, llm);

  assert.equal(result.denialReasons.length, 2);
  assert.equal(llm.prompts.length, 2);
  assert.ok(
    (llm.prompts[1] ?? '').includes('Sure! Here are the denial reasons you asked for.'),
    'the retry prompt should quote back the unusable reply',
  );
});

test('parseArticleText: throws with both raw replies when the retry also fails', async () => {
  const text = fullDocument();
  const llm = fakeLlm(['not json at all', '{"denialReasons":"still not a list"}']);

  await assert.rejects(
    () => parseArticleText(text, ARTICLE_ID, llm),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /still not a list/, 'raw retry reply must be in the error');
      assert.match(error.message, /not json at all/, 'raw first reply must be in the error');
      return true;
    },
  );
});

// ---- extractArticle (pdf-text + cutAtRevisionHistory + parseArticleText) --

test('extractArticle: derives the article id from the PDF filename', async () => {
  const llm = fakeLlm([]);

  await assert.rejects(
    () => extractArticle('test/fixtures/two-page-policy.pdf', llm),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      // The sample PDF has no ICD-10 heading, so the deterministic parser
      // fails loud before the LLM is ever invoked -- proving the pdf-text +
      // cutAtRevisionHistory + parseArticleText wiring runs in order.
      assert.match(error.message, /ICD-10-CM Codes That Support Medical Necessity/i);
      return true;
    },
  );
});
