export type RequirementCategory = 'indication' | 'documentation' | 'limitation';

export const REQUIREMENT_CATEGORIES: readonly RequirementCategory[] = [
  'indication',
  'documentation',
  'limitation',
];

/** One discrete, checkable obligation lifted out of a coverage policy. */
export interface Requirement {
  readonly id: string;
  readonly text: string;
  readonly ordinal: number;
  readonly category: RequirementCategory;
}
