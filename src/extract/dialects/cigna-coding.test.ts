import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCignaCodingInformation } from './cigna-coding.ts';

// Shapes taken from the real document (condensed, synthetic wording/codes),
// including the dual-stance main-table heading.
const SAMPLE = [
  'Coding Information',
  'Notes:',
  '1. This list of codes may not be all-inclusive.',
  'Considered Medically Necessary when criteria in the applicable policy statements listed',
  'above are met for the treatment of widget disease. Considered Not Medically Necessary for',
  'the treatment of squeaking in the absence of widget disease:',
  'CPT Codes Description',
  '12345 Widget implantation',
  '12346 Widget reconstruction',
  'HCPCS Codes Description',
  'A1234 Widget device',
  'Considered Not Medically Necessary when used to report widget removal as a stand-alone procedure:',
  '23456 Widget removal',
  'Considered Experimental/Investigational/Unproven for the treatment of widget disease:',
  '34567 Widget ablation',
  'C9876 Widget implant insertion',
  'General Background',
  'Widget therapy 12399 mentioned in prose must not be harvested.',
].join('\n');

test('page-1 TOC entries never anchor the coding region', () => {
  // Real 0158 regression: the TOC lists both region headings with dot
  // leaders and page numbers before the real sections appear.
  const withToc = [
    'Table of Contents',
    'Coding Information ............................ 4',
    'General Background ............................ 6',
    SAMPLE,
  ].join('\n');
  const { coveredCodes, denialReasons } = parseCignaCodingInformation(withToc, 'CIGNA-0101');
  assert.deepEqual(coveredCodes, [
    { system: 'CPT', code: '12345' },
    { system: 'CPT', code: '12346' },
    { system: 'HCPCS', code: 'A1234' },
  ]);
  assert.equal(denialReasons.length, 3);
});

test('MN table codes become covered codes with shape-derived systems', () => {
  const { coveredCodes } = parseCignaCodingInformation(SAMPLE, 'CIGNA-0101');
  assert.deepEqual(coveredCodes, [
    { system: 'CPT', code: '12345' },
    { system: 'CPT', code: '12346' },
    { system: 'HCPCS', code: 'A1234' },
  ]);
});

test('each non-MN stance statement becomes a denial reason applying to its table codes', () => {
  const { denialReasons } = parseCignaCodingInformation(SAMPLE, 'CIGNA-0101');
  const standalone = denialReasons.find((d) => d.text.includes('stand-alone'));
  assert.equal(standalone?.stance, 'not-medically-necessary');
  assert.deepEqual(standalone?.appliesTo, [{ system: 'CPT', code: '23456' }]);

  const experimental = denialReasons.find((d) => d.stance === 'experimental-investigational');
  assert.deepEqual(experimental?.appliesTo, [
    { system: 'CPT', code: '34567' },
    { system: 'HCPCS', code: 'C9876' },
  ]);
});

test('a dual-stance heading covers the table AND yields a denial reason spanning it', () => {
  const { coveredCodes, denialReasons } = parseCignaCodingInformation(SAMPLE, 'CIGNA-0101');
  const squeaking = denialReasons.find((d) => d.text.includes('squeaking'));
  assert.equal(squeaking?.stance, 'not-medically-necessary');
  // The snoring-analog statement applies to the same table the MN half covers.
  assert.deepEqual(squeaking?.appliesTo, coveredCodes);
});

test('denial-reason ids are lcd-scoped and ordered', () => {
  const { denialReasons } = parseCignaCodingInformation(SAMPLE, 'CIGNA-0101');
  assert.deepEqual(denialReasons.map((d) => d.id), ['CIGNA-0101-D1', 'CIGNA-0101-D2', 'CIGNA-0101-D3']);
});

test('codes in prose outside the region are never harvested', () => {
  const { coveredCodes, denialReasons } = parseCignaCodingInformation(SAMPLE, 'CIGNA-0101');
  const all = [...coveredCodes, ...denialReasons.flatMap((d) => d.appliesTo)].map((c) => c.code);
  assert.ok(!all.includes('12399'));
});

test('a missing Coding Information heading throws loud', () => {
  assert.throws(() => parseCignaCodingInformation('No coding section here.', 'CIGNA-0101'), /Coding Information/);
});
