import neo4j from 'neo4j-driver';

import type { GraphConfig } from './config.ts';

/**
 * The pipeline's only Neo4j dependency. Everything downstream talks to this
 * interface instead of neo4j-driver, so the driver has exactly one caller.
 */
export interface Graph {
  run(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

function isServiceUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ServiceUnavailable';
}

export function createGraph(config: GraphConfig): Graph {
  const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password), {
    // Cypher integers arrive as neo4j-driver's lossless Integer type by default;
    // this project's ids/counts fit safely in a JS number, so unwrap them here.
    disableLosslessIntegers: true,
    // A local dev container that isn't running should fail loud in seconds,
    // not after the driver's ~55s default connect-and-retry sequence.
    connectionTimeout: 5000,
  });

  return {
    async run(cypher, params = {}) {
      // A session (rather than driver.executeQuery) is deliberate: executeQuery
      // retries ServiceUnavailable for up to 30s, which turns "Neo4j is down"
      // into a slow failure instead of an immediate, actionable one.
      const session = driver.session({ database: config.database });
      try {
        const result = await session.run(cypher, params);
        return result.records.map((record) => record.toObject());
      } catch (error) {
        if (isServiceUnavailable(error)) {
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Cannot reach Neo4j at ${config.uri} (db ${config.database}): ${cause}. ` +
              `Start it with: docker compose up -d`,
          );
        }
        throw error;
      } finally {
        await session.close();
      }
    },
    async close() {
      await driver.close();
    },
  };
}
