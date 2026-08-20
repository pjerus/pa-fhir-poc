import test from 'node:test';
import assert from 'node:assert/strict';

import { cutAtRevisionHistory, splitSections } from './sections.ts';

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

  const { sections } = splitSections(text);

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

  const { sections } = splitSections(text);

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

  const { sections } = splitSections(text);

  assert.equal(sections.indications, 'The device is covered when the patient meets the criteria below.');
  assert.equal(sections.limitations, 'The device is covered when the patient meets the criteria below.');
  assert.equal(sections.documentation, 'The treating order must be retained and available on request.');
});

test('warns instead of crashing when a section heading is absent', () => {
  const text = ['Indications', 'The patient must have a documented diagnosis.'].join('\n');

  const { sections, warnings } = splitSections(text);

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

  const { sections, warnings } = splitSections(text);

  assert.equal(sections.indications, 'Real indications text.');
  assert.equal(sections.limitations, null);
  assert.ok(
    warnings.includes(
      'No "limitations" heading found; downstream extraction will skip that section.',
    ),
  );
});

test('cutAtRevisionHistory returns the text up to that heading', () => {
  const before = 'Some policy text before the cutoff.';
  const after = 'Indications: this must not resurface after the cutoff.';
  const text = [before, 'Revision History', after].join('\n');

  assert.equal(cutAtRevisionHistory(text), before);
});

test('cutAtRevisionHistory returns the whole input when the heading is absent', () => {
  const text = ['Line one.', 'Line two.'].join('\n');

  assert.equal(cutAtRevisionHistory(text), text);
});

test('revision history is terminal: no later heading can resume section assignment', () => {
  const text = [
    'Indications',
    'Real indications text.',
    'Revision History',
    'Documentation Requirements',
    'This is change-log boilerplate and must not be captured.',
  ].join('\n');

  const { sections, warnings } = splitSections(text);

  assert.equal(sections.indications, 'Real indications text.');
  assert.equal(sections.documentation, null);
  assert.ok(
    warnings.includes(
      'No "documentation" heading found; downstream extraction will skip that section.',
    ),
  );
});
