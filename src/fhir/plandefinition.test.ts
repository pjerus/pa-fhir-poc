import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPlanDefinition } from './plandefinition.ts';
import { instanceCanonical } from './profiles.ts';
import { syntheticSubgraph } from './test-support.ts';

test('buildPlanDefinition sets resourceType, status, url/version/title/name, and no meta key at all', () => {
  const planDefinition = buildPlanDefinition(syntheticSubgraph());

  assert.equal(planDefinition.resourceType, 'PlanDefinition');
  assert.equal(planDefinition.status, 'active');
  assert.equal(planDefinition.url, instanceCanonical('PlanDefinition', 'TEST-P-LCD1'));
  assert.equal(planDefinition.version, '3');
  assert.equal(planDefinition.title, 'Test policy');
  assert.equal(planDefinition.name, 'TEST-P-LCD1');
  assert.equal(planDefinition.id, 'TEST-P-LCD1');

  const roundTripped = JSON.parse(JSON.stringify(planDefinition)) as Record<string, unknown>;
  assert.ok(!('meta' in roundTripped));
});

test('buildPlanDefinition carries a generated narrative naming the LCD (dom-6 best practice)', () => {
  const planDefinition = buildPlanDefinition(syntheticSubgraph());

  assert.equal(planDefinition.text?.status, 'generated');
  assert.match(planDefinition.text?.div ?? '', /TEST-P-LCD1/);
  assert.match(planDefinition.text?.div ?? '', /^<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml">/);
});

test('buildPlanDefinition library deep-equals the CQL stub canonical', () => {
  const planDefinition = buildPlanDefinition(syntheticSubgraph());
  assert.deepEqual(planDefinition.library, [instanceCanonical('Library', 'TEST-P-LCD1-cql-stub')]);
});

test('buildPlanDefinition emits one action per covered code, each with a one-element CodeableConcept coding and the URI system', () => {
  const planDefinition = buildPlanDefinition(syntheticSubgraph());

  assert.equal(planDefinition.action?.length, 2);

  const [first, second] = planDefinition.action ?? [];
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(first.code, [
    { coding: [{ system: 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets', code: 'TEST-P-E9819' }] },
  ]);
  assert.deepEqual(second.code, [
    { coding: [{ system: 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets', code: 'TEST-P-K9813' }] },
  ]);

  assert.equal(first.definitionCanonical, instanceCanonical('Questionnaire', 'TEST-P-LCD1'));
  assert.equal(second.definitionCanonical, instanceCanonical('Questionnaire', 'TEST-P-LCD1'));
});

test('buildPlanDefinition throws when a covered code has an unknown system', () => {
  assert.throws(
    () =>
      buildPlanDefinition(
        syntheticSubgraph({ coveredCodes: [{ system: 'SNOMED', code: '12345' }] }),
      ),
    /SNOMED/,
  );
});
