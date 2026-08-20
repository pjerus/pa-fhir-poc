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
