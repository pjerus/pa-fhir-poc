import test from 'node:test';
import assert from 'node:assert/strict';

import { stubOllama } from '../../test/support/stub-ollama.ts';
import { createOllamaClient } from './llm-client.ts';

test('asks Ollama for a schema-constrained, non-streaming completion', async () => {
  const ollama = await stubOllama(() => ({
    status: 200,
    payload: { response: '{"requirements":[]}', done: true },
  }));

  try {
    const client = createOllamaClient({ baseUrl: ollama.baseUrl, model: 'test-model' });
    const reply = await client.complete({
      prompt: 'extract the requirements',
      schema: { type: 'object' },
    });

    assert.equal(reply, '{"requirements":[]}');
    assert.deepEqual(ollama.requests, [
      {
        url: '/api/generate',
        body: {
          model: 'test-model',
          prompt: 'extract the requirements',
          stream: false,
          think: false,
          format: { type: 'object' },
          options: { temperature: 0 },
        },
      },
    ]);
  } finally {
    await ollama.close();
  }
});

test('fails loudly when Ollama rejects the request', async () => {
  const ollama = await stubOllama(() => ({
    status: 404,
    payload: { error: 'model "qwen3.8:27b" not found, try pulling it first' },
  }));

  try {
    const client = createOllamaClient({ baseUrl: ollama.baseUrl, model: 'qwen3.8:27b' });

    await assert.rejects(
      () => client.complete({ prompt: 'extract the requirements' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /404/);
        assert.match(error.message, /qwen3\.8:27b/);
        assert.match(error.message, /not found, try pulling it first/);
        return true;
      },
    );
  } finally {
    await ollama.close();
  }
});
