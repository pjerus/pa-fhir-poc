import { REQUIREMENT_CATEGORIES, type Requirement, type RequirementCategory } from '../../src/types.ts';

/**
 * Hand-authored ground truth for one LCD. It pins structure — how many
 * requirements, of which categories, mentioning which phrases — and never
 * prose, because a local model's wording drifts between runs.
 */
export interface Expected {
  readonly requirementCount: number;
  readonly categoryDistribution: Readonly<Partial<Record<RequirementCategory, number>>>;
  readonly keyPhrases: readonly string[];
}

export function parseExpected(raw: unknown, source = '<inline>'): Expected {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${source}: expected a JSON object`);
  }
  const { requirementCount, categoryDistribution, keyPhrases } = raw as Record<string, unknown>;

  if (typeof requirementCount !== 'number' || !Number.isInteger(requirementCount)) {
    throw new Error(`${source}: "requirementCount" must be an integer`);
  }
  if (typeof categoryDistribution !== 'object' || categoryDistribution === null) {
    throw new Error(`${source}: "categoryDistribution" must be an object`);
  }
  for (const [category, count] of Object.entries(categoryDistribution)) {
    if (!REQUIREMENT_CATEGORIES.includes(category as RequirementCategory)) {
      throw new Error(
        `${source}: unknown category "${category}", expected one of: ` +
          REQUIREMENT_CATEGORIES.join(', '),
      );
    }
    if (typeof count !== 'number') throw new Error(`${source}: count for "${category}" must be a number`);
  }
  if (!Array.isArray(keyPhrases) || keyPhrases.some((phrase) => typeof phrase !== 'string')) {
    throw new Error(`${source}: "keyPhrases" must be an array of strings`);
  }

  return {
    requirementCount,
    categoryDistribution: categoryDistribution as Expected['categoryDistribution'],
    keyPhrases: keyPhrases as readonly string[],
  };
}

export function checkAgainstExpected(
  requirements: readonly Requirement[],
  expected: Expected,
): string[] {
  const failures: string[] = [];

  if (requirements.length !== expected.requirementCount) {
    failures.push(
      `expected ${expected.requirementCount} requirements, extracted ${requirements.length}`,
    );
  }

  for (const category of REQUIREMENT_CATEGORIES) {
    const wanted = expected.categoryDistribution[category] ?? 0;
    const got = requirements.filter((requirement) => requirement.category === category).length;
    if (wanted !== got) failures.push(`${category}: expected ${wanted}, extracted ${got}`);
  }

  const haystack = requirements.map((requirement) => requirement.text.toLowerCase());
  for (const phrase of expected.keyPhrases) {
    const needle = phrase.toLowerCase();
    if (!haystack.some((text) => text.includes(needle))) {
      failures.push(`no requirement mentions "${phrase}"`);
    }
  }

  return failures;
}
