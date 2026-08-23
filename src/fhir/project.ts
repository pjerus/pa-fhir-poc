import type { PlanDefinition, Questionnaire } from 'fhir/r4';

import type { ApprovedSubgraph } from '../graph/read.ts';
import { buildCrdResponse } from './crd.ts';
import type { CrdResponse } from './crd.ts';
import { buildDtrQuestionnaire } from './dtr.ts';
import { buildPlanDefinition } from './plandefinition.ts';

export interface ProjectedLcd {
  readonly crd: CrdResponse;
  /**
   * Absent when the policy states no documentation requirements:
   * dtr-std-questionnaire requires at least one item, so an empty
   * Questionnaire would be non-conformant — and a questionnaire with
   * nothing to ask serves no DTR purpose. Verified against the official
   * validator with CIGNA-0158 (see docs/conformance/).
   */
  readonly dtr?: Questionnaire;
  readonly planDefinition: PlanDefinition;
}

export function projectLcd(subgraph: ApprovedSubgraph): ProjectedLcd {
  const hasDocumentation = subgraph.requirements.some(
    (requirement) => requirement.category === 'documentation',
  );
  return {
    crd: buildCrdResponse(subgraph),
    ...(hasDocumentation ? { dtr: buildDtrQuestionnaire(subgraph) } : {}),
    planDefinition: buildPlanDefinition(subgraph),
  };
}
