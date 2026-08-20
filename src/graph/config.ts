import { existsSync } from 'node:fs';

export interface GraphConfig {
  readonly uri: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

const ENV_FILE = '.env';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable "${name}". Copy .env.example to .env and set it.`);
  }
  return value;
}

/** Loads `.env` (if present) then reads the Neo4j connection settings it defines. */
export function loadGraphConfig(): GraphConfig {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

  return {
    uri: requireEnv('NEO4J_URI'),
    user: requireEnv('NEO4J_USER'),
    password: requireEnv('NEO4J_PASSWORD'),
    database: requireEnv('NEO4J_DATABASE'),
  };
}
