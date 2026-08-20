import test from 'node:test';
import assert from 'node:assert/strict';

import type { LlmClient } from './llm-client.ts';
import { structureRequirements } from './structure.ts';

function fakeLlm(responses: readonly string[]): LlmClient & { readonly prompts: string[] } {
  const queue = [...responses];
  const prompts: string[] = [];
  return {
    prompts,
    async complete(request) {
      prompts.push(request.prompt);
      const next = queue.shift();
      if (next === undefined) throw new Error('fake LLM called more times than expected');
      return next;
    },
  };
}

test('turns a model response into ordinal-numbered typed requirements', async () => {
  const llm = fakeLlm([
    JSON.stringify({
      requirements: [
        { text: 'The patient has a documented diagnosis.', category: 'indication' },
        { text: 'The patient uses insulin.', category: 'indication' },
      ],
    }),
  ]);

  const requirements = await structureRequirements(
    {
      lcdId: 'L00001',
      sections: { indications: 'some policy prose', documentation: null, limitations: null },
    },
    llm,
  );

  assert.deepEqual(requirements, [
    {
      id: 'L00001-R1',
      text: 'The patient has a documented diagnosis.',
      ordinal: 1,
      category: 'indication',
    },
    { id: 'L00001-R2', text: 'The patient uses insulin.', ordinal: 2, category: 'indication' },
  ]);
});

test('retries once with a sharper instruction when the model returns unusable output', async () => {
  const llm = fakeLlm([
    'Sure! Here are the requirements you asked for.',
    JSON.stringify({
      requirements: [{ text: 'The patient has a documented diagnosis.', category: 'indication' }],
    }),
  ]);

  const requirements = await structureRequirements(
    {
      lcdId: 'L00001',
      sections: { indications: 'some policy prose', documentation: null, limitations: null },
    },
    llm,
  );

  assert.equal(requirements.length, 1);
  assert.equal(llm.prompts.length, 2);
  assert.ok(
    (llm.prompts[1] ?? '').includes('Sure! Here are the requirements you asked for.'),
    'the retry prompt should quote back the unusable reply',
  );
});

test('throws with the raw model output when the retry also fails', async () => {
  const llm = fakeLlm(['not json at all', '{"requirements":"still not a list"}']);

  await assert.rejects(
    () =>
      structureRequirements(
        {
          lcdId: 'L00001',
          sections: { indications: 'some policy prose', documentation: null, limitations: null },
        },
        llm,
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /still not a list/, 'raw model output must be in the error');
      assert.match(error.message, /not an array/, 'the parse failure must be in the error');
      assert.match(error.message, /indications/, 'the section must be identifiable');
      return true;
    },
  );
});

test('sends a body shared by a combined heading to the model only once', async () => {
  const shared = 'The device is covered when the patient meets the criteria below.';
  const llm = fakeLlm([
    JSON.stringify({
      requirements: [
        { text: 'The patient meets the coverage criteria.', category: 'indication' },
        { text: 'The device is not covered otherwise.', category: 'limitation' },
      ],
    }),
  ]);

  const requirements = await structureRequirements(
    { lcdId: 'L00001', sections: { indications: shared, documentation: null, limitations: shared } },
    llm,
  );

  assert.equal(llm.prompts.length, 1, 'a shared body must be sent once, not once per section');
  assert.deepEqual(
    requirements.map((requirement) => requirement.category),
    ['indication', 'limitation'],
  );
  assert.deepEqual(
    requirements.map((requirement) => requirement.id),
    ['L00001-R1', 'L00001-R2'],
  );
});
