import type { LlmClient } from '../../src/extract/llm-client.ts';

export interface FakeLlm extends LlmClient {
  readonly prompts: string[];
}

/** Replays queued replies so extraction can be tested without invoking a model. */
export function fakeLlm(responses: readonly string[]): FakeLlm {
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
