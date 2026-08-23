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

/** Graph-owned review lifecycle: never set by the extraction/input side. */
export type LcdStatus = 'draft' | 'approved';

export interface CodeRef {
  readonly system: string;
  readonly code: string;
}

/** How a payer's stance statement refuses coverage. Absent on MAC-sourced denial reasons. */
export type DenialStance = 'not-medically-necessary' | 'experimental-investigational';

export interface DenialReason {
  readonly id: string;
  readonly text: string;
  readonly stance?: DenialStance;
}

/** A denial reason plus the codes its source document explicitly groups under it. */
export interface PolicyDenialReason extends DenialReason {
  readonly appliesTo: readonly CodeRef[];
}

export interface LcdInput {
  readonly id: string;
  readonly title?: string;
  readonly version?: string;
  readonly sourceHash: string;
  readonly requirements: readonly Requirement[];
  readonly coveredCodes: readonly CodeRef[];
  /** Present for single-document dialects whose policy states its own denial reasons. */
  readonly denialReasons?: readonly PolicyDenialReason[];
}

export interface ArticleInput {
  readonly id: string;
  readonly title?: string;
  readonly version?: string;
  readonly sourceHash: string;
  readonly listedCodes: readonly CodeRef[];
  readonly denialReasons: readonly DenialReason[];
}

/** The human decision that unblocks the review workflow's signal wait. */
export interface ReviewDecision {
  readonly decision: 'approve' | 'reject';
  readonly reviewer: string;
  readonly note?: string;
}
