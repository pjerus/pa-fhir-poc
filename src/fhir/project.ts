import type { PlanDefinition, Questionnaire } from 'fhir/r4';

import type { ApprovedSubgraph } from '../graph/read.ts';
import { buildCrdResponse } from './crd.ts';
import type { CrdResponse } from './crd.ts';
import { buildDtrQuestionnaire } from './dtr.ts';
import { buildPlanDefinition } from './plandefinition.ts';

export interface ProjectedLcd {
  readonly crd: CrdResponse;
  readonly dtr: Questionnaire;
  readonly planDefinition: PlanDefinition;
}

export function projectLcd(subgraph: ApprovedSubgraph): ProjectedLcd {
  return {
    crd: buildCrdResponse(subgraph),
    dtr: buildDtrQuestionnaire(subgraph),
    planDefinition: buildPlanDefinition(subgraph),
  };
}
