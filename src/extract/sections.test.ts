import test from 'node:test';
import assert from 'node:assert/strict';

import type { SectionVocabulary } from './sections.ts';
import { cutAtTerminal, splitSections } from './sections.ts';
import { MAC_VOCABULARY } from './dialects/mac.ts';

test('splits a policy into its three sections by heading', () => {
  const text = [
    'LOCAL COVERAGE DETERMINATION',
    '',
    'Indications',
    'The patient must have a documented diagnosis.',
    '',
    'Documentation Requirements',
    'The medical record must contain the treating order.',
    '',
    'Limitations',
    'More than one unit per month is not reasonable and necessary.',
  ].join('\n');

  const { sections } = splitSections(text, MAC_VOCABULARY);

  assert.equal(sections.indications, 'The patient must have a documented diagnosis.');
  assert.equal(sections.documentation, 'The medical record must contain the treating order.');
  assert.equal(
    sections.limitations,
    'More than one unit per month is not reasonable and necessary.',
  );
});

test('does not treat a prose sentence mentioning a section word as a heading', () => {
  const text = [
    'Indications',
    'The patient must have a documented diagnosis.',
    'Documentation of that diagnosis must be available upon request.',
  ].join('\n');

  const { sections } = splitSections(text, MAC_VOCABULARY);

  assert.equal(
    sections.indications,
    'The patient must have a documented diagnosis.\n' +
      'Documentation of that diagnosis must be available upon request.',
  );
  assert.equal(sections.documentation, null);
});

test('feeds a combined heading to every section it names', () => {
  const text = [
    'Coverage Indications, Limitations, and/or Medical Necessity',
    'The device is covered when the patient meets the criteria below.',
    'Documentation Requirements',
    'The treating order must be retained and available on request.',
  ].join('\n');

  const { sections } = splitSections(text, MAC_VOCABULARY);

  assert.equal(sections.indications, 'The device is covered when the patient meets the criteria below.');
  assert.equal(sections.limitations, 'The device is covered when the patient meets the criteria below.');
  assert.equal(sections.documentation, 'The treating order must be retained and available on request.');
});

test('a hard-wrapped fragment starting lowercase is never a heading', () => {
  const text = [
    'Indications',
    'The AHI is greater than or equal to 5 with a minimum',
    'of 10 events and documentation of:',
    'Excessive daytime sleepiness or impaired cognition',
  ].join('\n');

  const { sections } = splitSections(text, MAC_VOCABULARY);

  assert.equal(sections.documentation, null);
  assert.ok(sections.indications?.includes('Excessive daytime sleepiness'));
});

test('a line starting with a digit or a quote is never a heading', () => {
  const text = [
    'Indications',
    '1, 2008, documentation of clinical benefit is demonstrated by:',
    '"Coverage Indications, Limitations and/or Medical Necessity"',
    'The criteria of both policies must be met.',
  ].join('\n');

  const { sections } = splitSections(text, MAC_VOCABULARY);

  assert.equal(sections.documentation, null);
  assert.equal(sections.limitations, null);
  assert.ok(sections.indications?.includes('The criteria of both policies must be met.'));
});

test('a cross-reference naming a section deep in the line is not a heading', () => {
  const text = [
    'Indications',
    'The device is covered when the criteria below are met.',
    'Refer to Coverage Indications, Limitations, and/or Medical',
    'Necessity for other coverage criteria',
  ].join('\n');

  const { sections } = splitSections(text, MAC_VOCABULARY);

  assert.equal(sections.limitations, null);
  assert.ok(sections.indications?.includes('Necessity for other coverage criteria'));
});

test('a heading may carry a qualifier prefix before its section word', () => {
  const text = [
    'Indications',
    'Coverage criteria text.',
    'POLICY SPECIFIC DOCUMENTATION REQUIREMENTS',
    'The order must be retained.',
  ].join('\n');

  const { sections } = splitSections(text, MAC_VOCABULARY);

  assert.equal(sections.documentation, 'The order must be retained.');
});

test('warns instead of crashing when a section heading is absent', () => {
  const text = ['Indications', 'The patient must have a documented diagnosis.'].join('\n');

  const { sections, warnings } = splitSections(text, MAC_VOCABULARY);

  assert.equal(sections.documentation, null);
  assert.equal(sections.limitations, null);
  assert.deepEqual(warnings, [
    'No "documentation" heading found; downstream extraction will skip that section.',
    'No "limitations" heading found; downstream extraction will skip that section.',
  ]);
});

test('a heading-candidate line repeated more than 3 times is a recurring table label, not a heading', () => {
  const text = [
    'Indications',
    'Real indications text.',
    'LIMITATION',
    'LIMITATION',
    'LIMITATION',
    'LIMITATION',
  ].join('\n');

  const { sections, warnings } = splitSections(text, MAC_VOCABULARY);

  assert.equal(sections.indications, 'Real indications text.');
  assert.equal(sections.limitations, null);
  assert.ok(
    warnings.includes(
      'No "limitations" heading found; downstream extraction will skip that section.',
    ),
  );
});

test('cutAtTerminal returns the text up to that heading', () => {
  const before = 'Some policy text before the cutoff.';
  const after = 'Indications: this must not resurface after the cutoff.';
  const text = [before, 'Revision History', after].join('\n');

  assert.equal(cutAtTerminal(text, MAC_VOCABULARY.terminal), before);
});

test('cutAtTerminal returns the whole input when the heading is absent', () => {
  const text = ['Line one.', 'Line two.'].join('\n');

  assert.equal(cutAtTerminal(text, MAC_VOCABULARY.terminal), text);
});

test('revision history is terminal: no later heading can resume section assignment', () => {
  const text = [
    'Indications',
    'Real indications text.',
    'Revision History',
    'Documentation Requirements',
    'This is change-log boilerplate and must not be captured.',
  ].join('\n');

  const { sections, warnings } = splitSections(text, MAC_VOCABULARY);

  assert.equal(sections.indications, 'Real indications text.');
  assert.equal(sections.documentation, null);
  assert.ok(
    warnings.includes(
      'No "documentation" heading found; downstream extraction will skip that section.',
    ),
  );
});

test('splitSections takes a vocabulary: MAC vocabulary reproduces current behavior', () => {
  const text = ['Coverage Indications', 'Body A.', 'Documentation Requirements', 'Body B.'].join('\n');
  const { sections } = splitSections(text, MAC_VOCABULARY);
  assert.equal(sections.indications, 'Body A.');
  assert.equal(sections.documentation, 'Body B.');
});

test('a boundary heading ends the current section without opening one', () => {
  const vocabulary: SectionVocabulary = {
    headings: [{ sections: ['indications'], pattern: /^Coverage\s+Policy\b/i }],
    boundaries: [/^General\s+Background\b/i],
    terminal: /revision\s+details/i,
  };
  const text = ['Coverage Policy', 'Real criterion.', 'General Background', 'Literature noise.'].join('\n');
  const { sections } = splitSections(text, vocabulary);
  assert.equal(sections.indications, 'Real criterion.');
});

test('a dot-leader table-of-contents line is never a heading', () => {
  const vocabulary: SectionVocabulary = {
    headings: [{ sections: ['indications'], pattern: /^Coverage\s+Policy\b/i }],
    boundaries: [],
    terminal: /revision\s+details/i,
  };
  const text = ['Coverage Policy ......................... 2', 'TOC junk.', 'Coverage Policy', 'Real criterion.'].join(
    '\n',
  );
  const { sections } = splitSections(text, vocabulary);
  assert.equal(sections.indications, 'Real criterion.');
});

test('cutAtTerminal cuts at the supplied terminal heading', () => {
  const text = ['Keep this.', 'Revision Details', 'Change log.'].join('\n');
  assert.equal(cutAtTerminal(text, /revision\s+details/i), 'Keep this.');
});
