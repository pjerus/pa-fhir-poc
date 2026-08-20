/**
 * Canonical URLs and the graph-code-system-name -> FHIR-code-system-URI lookup.
 * Sole home for both, per CLAUDE.md's open question: Code.system stays a short
 * name (`'HCPCS'`, `'ICD-10-CM'`) in the graph; the canonical URI is resolved
 * here, once, at projection time.
 */

/** DTR IG v2.2.0, verified against the published spec. */
export const DTR_STD_QUESTIONNAIRE_PROFILE =
  'http://hl7.org/fhir/us/davinci-dtr/StructureDefinition/dtr-std-questionnaire';

/** FHIR R4 core extension. */
export const CQF_LIBRARY_EXTENSION = 'http://hl7.org/fhir/StructureDefinition/cqf-library';

/** THO v7.3.0 external code systems — verified character-for-character, including the plain `http`. */
const CODE_SYSTEM_URIS: Readonly<Record<string, string>> = {
  HCPCS: 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets',
  'ICD-10-CM': 'http://hl7.org/fhir/sid/icd-10-cm',
};

export function codeSystemUri(system: string): string {
  const uri = CODE_SYSTEM_URIS[system];
  if (uri === undefined) {
    throw new Error(
      `Unknown code system "${system}" — known systems: ${Object.keys(CODE_SYSTEM_URIS).join(', ')}`,
    );
  }
  return uri;
}

/** POC-owned instance canonicals; example.org on purpose — this repo publishes nothing. */
export const CANONICAL_BASE = 'http://example.org/pa-fhir-poc';

export function instanceCanonical(resourceType: string, id: string): string {
  return `${CANONICAL_BASE}/${resourceType}/${id}`;
}
