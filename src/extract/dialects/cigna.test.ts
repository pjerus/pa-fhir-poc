import test from 'node:test';
import assert from 'node:assert/strict';

import { CIGNA_VOCABULARY } from './cigna.ts';
import { cutAtTerminal, splitSections } from '../sections.ts';

// Condensed from the real document shape; synthetic wording.
const SAMPLE = [
  'Medical Coverage Policy',
  'Coverage Policy Number 0101',
  'Table of Contents',
  'Coverage Policy ......................... 2',
  'INSTRUCTIONS FOR USE',
  'Plan documents supersede this policy.',
  'Overview',
  'This Coverage Policy addresses widget therapy.',
  'Coverage Policy',
  'Widget therapy is considered medically necessary when ALL of the following are met:',
  'documented diagnosis of testitis',
  'Widget removal as a stand-alone procedure is considered not medically necessary.',
  'Coding Information',
  'Considered Medically Necessary when criteria above are met:',
  '12345 Widget implantation',
  'General Background',
  'Literature review noise.',
  'References',
  'Author A. Journal of Widgets.',
  'Revision Details',
  'Annual review.',
].join('\n');

test('Coverage Policy body maps to indications + limitations, and only that body', () => {
  const { sections } = splitSections(cutAtTerminal(SAMPLE, CIGNA_VOCABULARY.terminal), CIGNA_VOCABULARY);
  assert.equal(sections.indications, sections.limitations);
  assert.match(sections.indications ?? '', /considered medically necessary when ALL/);
  assert.match(sections.indications ?? '', /stand-alone procedure is considered not medically necessary/);
});

test('boundary sections never bleed into the criteria body', () => {
  const { sections } = splitSections(cutAtTerminal(SAMPLE, CIGNA_VOCABULARY.terminal), CIGNA_VOCABULARY);
  for (const noise of [/Literature review noise/, /Journal of Widgets/, /Widget implantation/, /Plan documents supersede/, /addresses widget therapy/]) {
    assert.doesNotMatch(sections.indications ?? '', noise);
  }
});

test('the page banner and TOC lines do not open the Coverage Policy section early', () => {
  const { sections } = splitSections(cutAtTerminal(SAMPLE, CIGNA_VOCABULARY.terminal), CIGNA_VOCABULARY);
  assert.doesNotMatch(sections.indications ?? '', /Coverage Policy Number/);
  assert.doesNotMatch(sections.indications ?? '', /Table of Contents/);
});

test('Cigna has no documentation section — the splitter warns, not throws', () => {
  const { sections, warnings } = splitSections(cutAtTerminal(SAMPLE, CIGNA_VOCABULARY.terminal), CIGNA_VOCABULARY);
  assert.equal(sections.documentation, null);
  assert.ok(warnings.some((w) => w.includes('documentation')));
});

test('Revision Details is terminal', () => {
  assert.doesNotMatch(cutAtTerminal(SAMPLE, CIGNA_VOCABULARY.terminal), /Annual review/);
});
