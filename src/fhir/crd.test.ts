import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCrdResponse } from './crd.ts';
import { instanceCanonical } from './profiles.ts';
import { syntheticSubgraph } from './test-support.ts';

test('buildCrdResponse emits exactly one card', () => {
  const response = buildCrdResponse(syntheticSubgraph());
  assert.equal(response.cards.length, 1);
});

test('buildCrdResponse summary contains the lcdId, indicator is info', () => {
  const [card] = buildCrdResponse(syntheticSubgraph()).cards;
  assert.ok(card);
  assert.match(card.summary, /TEST-P-LCD1/);
  assert.equal(card.indicator, 'info');
});

test('buildCrdResponse summary never exceeds 140 chars, even with a 300-char title', () => {
  const longTitle = 'T'.repeat(300);
  const [card] = buildCrdResponse(
    syntheticSubgraph({ lcd: { id: 'TEST-P-LCD1', title: longTitle, status: 'approved', sourceHash: 'hash-lcd' } }),
  ).cards;
  assert.ok(card);
  assert.ok(card.summary.length <= 140);
});

test('buildCrdResponse source.label contains lcdId and title', () => {
  const [card] = buildCrdResponse(syntheticSubgraph()).cards;
  assert.ok(card);
  assert.match(card.source.label, /TEST-P-LCD1/);
  assert.match(card.source.label, /Test policy/);
});

test('buildCrdResponse detail contains every covered code pair and every requirement text, plus the documentation heading', () => {
  const [card] = buildCrdResponse(syntheticSubgraph()).cards;
  assert.ok(card);
  assert.match(card.detail, /HCPCS E9819/);
  assert.match(card.detail, /HCPCS K9813/);
  assert.match(card.detail, /Indication requirement one\./);
  assert.match(card.detail, /Documentation requirement one\./);
  assert.match(card.detail, /Documentation requirement two\./);
  assert.match(card.detail, /Limitation requirement one\./);
  assert.match(card.detail, /### documentation/);
});

test('buildCrdResponse detail omits the limitation heading when there are only indication requirements', () => {
  const [card] = buildCrdResponse(
    syntheticSubgraph({
      requirements: [{ id: 'TEST-P-LCD1-R1', text: 'Indication only.', ordinal: 1, category: 'indication' }],
    }),
  ).cards;
  assert.ok(card);
  assert.match(card.detail, /### indication/);
  assert.doesNotMatch(card.detail, /### limitation/);
  assert.doesNotMatch(card.detail, /### documentation/);
});

test('buildCrdResponse emits one link to the Questionnaire canonical', () => {
  const [card] = buildCrdResponse(syntheticSubgraph()).cards;
  assert.ok(card);
  assert.equal(card.links.length, 1);
  const [link] = card.links;
  assert.ok(link);
  assert.equal(link.type, 'absolute');
  assert.equal(link.url, instanceCanonical('Questionnaire', 'TEST-P-LCD1'));
});
