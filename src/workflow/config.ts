import { existsSync } from 'node:fs';

export interface TemporalConfig {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
}

const ENV_FILE = '.env';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable "${name}". Copy .env.example to .env and set it.`);
  }
  return value;
}

/** Loads `.env` (if present) then reads the Temporal connection settings it defines. */
export function loadTemporalConfig(): TemporalConfig {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

  return {
    address: requireEnv('TEMPORAL_ADDRESS'),
    namespace: requireEnv('TEMPORAL_NAMESPACE'),
    taskQueue: requireEnv('TEMPORAL_TASK_QUEUE'),
  };
}
