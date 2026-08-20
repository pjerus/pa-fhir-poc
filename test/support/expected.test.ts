import test from 'node:test';
import assert from 'node:assert/strict';

import type { Requirement } from '../../src/types.ts';
import { checkAgainstExpected, parseExpected } from './expected.ts';

function requirement(partial: Partial<Requirement> & Pick<Requirement, 'text' | 'category'>): Requirement {
  return { id: 'X-R1', ordinal: 1, ...partial };
}

const EXPECTED = {
  requirementCount: 2,
  categoryDistribution: { indication: 1, documentation: 1 },
  keyPhrases: ['documented diagnosis', 'treating order'],
};

test('reports no failures when count, distribution and key phrases all match', () => {
  const failures = checkAgainstExpected(
    [
      requirement({ text: 'The patient must have a documented diagnosis.', category: 'indication' }),
      requirement({ text: 'The treating order must be retained.', category: 'documentation' }),
    ],
    parseExpected(EXPECTED),
  );

  assert.deepEqual(failures, []);
});

test('reports the requirement count when it does not match', () => {
  const failures = checkAgainstExpected(
    [requirement({ text: 'The patient must have a documented diagnosis.', category: 'indication' })],
    parseExpected(EXPECTED),
  );

  assert.ok(
    failures.some((failure) => /expected 2 requirements, extracted 1/.test(failure)),
    `expected a count failure, got: ${JSON.stringify(failures)}`,
  );
});

test('reports a category whose count does not match', () => {
  const failures = checkAgainstExpected(
    [
      requirement({ text: 'The patient must have a documented diagnosis.', category: 'indication' }),
      requirement({ text: 'The treating order must be retained.', category: 'indication' }),
    ],
    parseExpected(EXPECTED),
  );

  assert.ok(
    failures.some((failure) => /documentation: expected 1, extracted 0/.test(failure)),
    `expected a distribution failure, got: ${JSON.stringify(failures)}`,
  );
  assert.ok(
    failures.some((failure) => /indication: expected 1, extracted 2/.test(failure)),
    `expected a distribution failure, got: ${JSON.stringify(failures)}`,
  );
});

test('reports a key phrase that appears in no extracted requirement', () => {
  const failures = checkAgainstExpected(
    [
      requirement({ text: 'The patient must have a documented diagnosis.', category: 'indication' }),
      requirement({ text: 'Records must be kept on file.', category: 'documentation' }),
    ],
    parseExpected(EXPECTED),
  );

  assert.ok(
    failures.some((failure) => /no requirement mentions "treating order"/.test(failure)),
    `expected a key-phrase failure, got: ${JSON.stringify(failures)}`,
  );
});

test('matches key phrases case-insensitively', () => {
  const failures = checkAgainstExpected(
    [
      requirement({ text: 'The patient must have a DOCUMENTED DIAGNOSIS.', category: 'indication' }),
      requirement({ text: 'The Treating Order must be retained.', category: 'documentation' }),
    ],
    parseExpected(EXPECTED),
  );

  assert.deepEqual(failures, []);
});
