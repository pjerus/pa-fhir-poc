import type { Questionnaire, QuestionnaireItem } from 'fhir/r4';

import type { ApprovedSubgraph } from '../graph/read.ts';
import { CQF_LIBRARY_EXTENSION, DTR_STD_QUESTIONNAIRE_PROFILE, instanceCanonical } from './profiles.ts';

/**
 * Boolean items are a documentation attestation ("is this documented?"). A
 * real DTR form would prepopulate these via CQL against the patient record.
 * TODO: real CQL generation is out of scope for this POC (see CLAUDE.md).
 */
export function buildDtrQuestionnaire(subgraph: ApprovedSubgraph): Questionnaire {
  const { lcd, requirements } = subgraph;

  const items: QuestionnaireItem[] = requirements
    .filter((requirement) => requirement.category === 'documentation')
    .map((requirement) => ({
      linkId: requirement.id,
      text: requirement.text,
      type: 'boolean',
    }));

  return {
    resourceType: 'Questionnaire',
    id: lcd.id,
    meta: { profile: [DTR_STD_QUESTIONNAIRE_PROFILE] },
    url: instanceCanonical('Questionnaire', lcd.id),
    ...(lcd.version !== undefined ? { version: lcd.version } : {}),
    ...(lcd.title !== undefined ? { title: lcd.title } : {}),
    name: lcd.id,
    status: 'active',
    extension: [
      {
        url: CQF_LIBRARY_EXTENSION,
        valueCanonical: instanceCanonical('Library', `${lcd.id}-cql-stub`),
      },
    ],
    ...(items.length > 0 ? { item: items } : {}),
  };
}
