import type { ApprovedSubgraph } from '../graph/read.ts';
import { REQUIREMENT_CATEGORIES } from '../types.ts';
import { instanceCanonical } from './profiles.ts';

/** CDS Hooks limits card summaries to 140 characters. */
const SUMMARY_MAX_LENGTH = 140;

export interface CdsLink {
  readonly label: string;
  readonly url: string;
  readonly type: 'absolute';
}

export interface CdsCard {
  readonly summary: string;
  readonly indicator: 'info';
  readonly source: { readonly label: string };
  readonly detail: string;
  readonly links: readonly CdsLink[];
}

export interface CrdResponse {
  readonly cards: readonly CdsCard[];
}

function titleClause(title: string | undefined): string {
  return title !== undefined ? ` — ${title}` : '';
}

function buildDetail(subgraph: ApprovedSubgraph): string {
  const { coveredCodes, requirements } = subgraph;

  const codesSection = ['## Covered codes', ...coveredCodes.map((c) => `${c.system} ${c.code}`)].join('\n');

  const requirementGroups = REQUIREMENT_CATEGORIES.map((category) => {
    const inCategory = requirements.filter((requirement) => requirement.category === category);
    if (inCategory.length === 0) {
      return undefined;
    }
    const items = inCategory.map((requirement, index) => `${index + 1}. ${requirement.text}`).join('\n');
    return `### ${category}\n${items}`;
  }).filter((group): group is string => group !== undefined);

  const requirementsSection = ['## Requirements', ...requirementGroups].join('\n\n');

  return [codesSection, requirementsSection].join('\n\n');
}

/**
 * CRD v2.2.1 models the CDS Hooks response as the `CRDHooksResponse` logical
 * model — a CDS Hooks card is JSON, not a FHIR resource, so this carries no
 * meta.profile (verified absence, not an oversight).
 */
export function buildCrdResponse(subgraph: ApprovedSubgraph): CrdResponse {
  const { lcd } = subgraph;

  const summary = `Prior authorization: documentation requirements apply (${lcd.id}${titleClause(lcd.title)})`.slice(
    0,
    SUMMARY_MAX_LENGTH,
  );

  return {
    cards: [
      {
        summary,
        indicator: 'info',
        source: { label: `Medicare LCD ${lcd.id}${titleClause(lcd.title)}` },
        detail: buildDetail(subgraph),
        links: [
          {
            label: 'Complete the documentation questionnaire',
            url: instanceCanonical('Questionnaire', lcd.id),
            type: 'absolute',
          },
        ],
      },
    ],
  };
}
