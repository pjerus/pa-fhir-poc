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
        // Streamed deliberately: with stream:false Ollama sends response
        // headers only when generation COMPLETES, so any generation longer
        // than undici's default 300s headersTimeout dies as "fetch failed".
        // Long policy sections routinely cross that line on a 27B model.
        stream: true,
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
      if (response.body === null) {
        throw new Error(`Ollama at ${endpoint.origin} returned no response body.`);
      }

      // NDJSON: one object per line, each carrying a "response" fragment.
      let reply = '';
      let sawFragment = false;
      const consumeLine = (line: string): void => {
        if (line === '') return;
        const parsed = JSON.parse(line) as { response?: unknown; error?: unknown };
        if (parsed.error !== undefined) {
          throw new Error(`Ollama streamed an error: ${String(parsed.error)}`);
        }
        if (typeof parsed.response === 'string') {
          reply += parsed.response;
          sawFragment = true;
        }
      };

      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          consumeLine(buffer.slice(0, newline).trim());
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      consumeLine(buffer.trim());

      if (!sawFragment) {
        throw new Error(`Ollama returned no "response" field in its stream.`);
      }
      return reply;
    },
  };
}
