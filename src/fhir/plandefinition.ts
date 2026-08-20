import type { PlanDefinition, PlanDefinitionAction } from 'fhir/r4';

import type { ApprovedSubgraph } from '../graph/read.ts';
import { codeSystemUri, instanceCanonical } from './profiles.ts';

/**
 * Base R4 — verified that neither the CRD nor DTR v2.2 IGs profile
 * PlanDefinition, so this carries no meta.profile.
 */
export function buildPlanDefinition(subgraph: ApprovedSubgraph): PlanDefinition {
  const { lcd, coveredCodes } = subgraph;

  const questionnaireCanonical = instanceCanonical('Questionnaire', lcd.id);

  const action: PlanDefinitionAction[] = coveredCodes.map((codeRef) => ({
    title: `Documentation required for ${codeRef.system} ${codeRef.code}`,
    code: [{ coding: [{ system: codeSystemUri(codeRef.system), code: codeRef.code }] }],
    definitionCanonical: questionnaireCanonical,
  }));

  return {
    resourceType: 'PlanDefinition',
    id: lcd.id,
    url: instanceCanonical('PlanDefinition', lcd.id),
    ...(lcd.version !== undefined ? { version: lcd.version } : {}),
    ...(lcd.title !== undefined ? { title: lcd.title } : {}),
    name: lcd.id,
    status: 'active',
    library: [instanceCanonical('Library', `${lcd.id}-cql-stub`)],
    action,
  };
}
