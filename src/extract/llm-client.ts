export interface LlmRequest {
  readonly prompt: string;
  /** JSON Schema constraining the reply, for backends that support it. */
  readonly schema?: unknown;
}

/**
 * The pipeline's single non-deterministic dependency. Everything downstream of
 * extraction reads a snapshot instead, so this interface has exactly one caller.
 */
export interface LlmClient {
  complete(request: LlmRequest): Promise<string>;
}

export interface OllamaConfig {
  readonly baseUrl: string;
  readonly model: string;
}

export function createOllamaClient(config: OllamaConfig): LlmClient {
  const endpoint = new URL('/api/generate', config.baseUrl);

  return {
    async complete({ prompt, schema }) {
      const body: Record<string, unknown> = {
        model: config.model,
        prompt,
        stream: false,
        // Extraction wants the answer, not the model's reasoning trace.
        think: false,
        options: { temperature: 0 },
      };
      if (schema !== undefined) body.format = schema;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(
          `Ollama at ${endpoint.origin} refused the request for model ` +
            `"${config.model}" (HTTP ${response.status}): ${await response.text()}`,
        );
      }

      const payload: unknown = await response.json();
      const reply = (payload as { response?: unknown }).response;
      if (typeof reply !== 'string') {
        throw new Error(`Ollama returned no "response" field: ${JSON.stringify(payload)}`);
      }
      return reply;
    },
  };
}
