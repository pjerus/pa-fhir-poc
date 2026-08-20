import test from 'node:test';
import assert from 'node:assert/strict';

import {
  codeSystemUri,
  instanceCanonical,
  DTR_STD_QUESTIONNAIRE_PROFILE,
  CQF_LIBRARY_EXTENSION,
} from './profiles.ts';
import { buildDtrQuestionnaire } from './dtr.ts';
import { syntheticSubgraph } from './test-support.ts';

test('codeSystemUri returns the verified HCPCS canonical', () => {
  assert.equal(codeSystemUri('HCPCS'), 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets');
});

test('codeSystemUri returns the verified ICD-10-CM canonical', () => {
  assert.equal(codeSystemUri('ICD-10-CM'), 'http://hl7.org/fhir/sid/icd-10-cm');
});

test('codeSystemUri throws naming the unknown system and the known systems', () => {
  assert.throws(
    () => codeSystemUri('SNOMED'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /SNOMED/);
      assert.match(error.message, /HCPCS/);
      assert.match(error.message, /ICD-10-CM/);
      return true;
    },
  );
});

test('instanceCanonical builds a POC-owned instance canonical URL', () => {
  assert.equal(instanceCanonical('Questionnaire', 'X'), 'http://example.org/pa-fhir-poc/Questionnaire/X');
});

test('buildDtrQuestionnaire sets resourceType, meta.profile, status, url/version/title/name', () => {
  const questionnaire = buildDtrQuestionnaire(syntheticSubgraph());

  assert.equal(questionnaire.resourceType, 'Questionnaire');
  assert.deepEqual(questionnaire.meta?.profile, [DTR_STD_QUESTIONNAIRE_PROFILE]);
  assert.equal(questionnaire.status, 'active');
  assert.equal(questionnaire.url, instanceCanonical('Questionnaire', 'TEST-P-LCD1'));
  assert.equal(questionnaire.version, '3');
  assert.equal(questionnaire.title, 'Test policy');
  assert.equal(questionnaire.name, 'TEST-P-LCD1');
  assert.equal(questionnaire.id, 'TEST-P-LCD1');
});

test('buildDtrQuestionnaire carries a cqf-library extension pointing at the CQL stub canonical', () => {
  const questionnaire = buildDtrQuestionnaire(syntheticSubgraph());

  assert.deepEqual(questionnaire.extension, [
    {
      url: CQF_LIBRARY_EXTENSION,
      valueCanonical: instanceCanonical('Library', 'TEST-P-LCD1-cql-stub'),
    },
  ]);
});

test('buildDtrQuestionnaire emits one boolean item per documentation requirement, in ordinal order', () => {
  const questionnaire = buildDtrQuestionnaire(syntheticSubgraph());

  assert.deepEqual(questionnaire.item, [
    { linkId: 'TEST-P-LCD1-R2', text: 'Documentation requirement one.', type: 'boolean' },
    { linkId: 'TEST-P-LCD1-R3', text: 'Documentation requirement two.', type: 'boolean' },
  ]);
});

test('buildDtrQuestionnaire yields no item entries when there are no documentation requirements', () => {
  const questionnaire = buildDtrQuestionnaire(
    syntheticSubgraph({
      requirements: [{ id: 'TEST-P-LCD1-R1', text: 'Indication only.', ordinal: 1, category: 'indication' }],
    }),
  );

  assert.equal(questionnaire.item, undefined);
});

test('buildDtrQuestionnaire omits version and title when absent on the LCD, with no undefined keys', () => {
  const questionnaire = buildDtrQuestionnaire(
    syntheticSubgraph({
      lcd: { id: 'TEST-P-LCD1', status: 'approved', sourceHash: 'hash-lcd' },
    }),
  );

  assert.equal(questionnaire.version, undefined);
  assert.equal(questionnaire.title, undefined);

  const roundTripped = JSON.parse(JSON.stringify(questionnaire)) as Record<string, unknown>;
  assert.ok(!('version' in roundTripped));
  assert.ok(!('title' in roundTripped));
});
