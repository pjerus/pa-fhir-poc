import type { Graph } from './db.ts';

/** The graph's five node labels — single source of truth for every other module. */
export const NODE = {
  LCD: 'LCD',
  REQUIREMENT: 'Requirement',
  CODE: 'Code',
  ARTICLE: 'Article',
  DENIAL_REASON: 'DenialReason',
} as const;

/** The graph's six relationship types — single source of truth for every other module. */
export const REL = {
  REQUIRES: 'REQUIRES',
  COVERS: 'COVERS',
  HAS_ARTICLE: 'HAS_ARTICLE',
  LISTS: 'LISTS',
  DEFINES: 'DEFINES',
  APPLIES_TO: 'APPLIES_TO',
} as const;

const UNIQUENESS_CONSTRAINTS: ReadonlyArray<{ readonly name: string; readonly label: string }> = [
  { name: 'lcd_id_unique', label: NODE.LCD },
  { name: 'article_id_unique', label: NODE.ARTICLE },
  { name: 'requirement_id_unique', label: NODE.REQUIREMENT },
  { name: 'denial_reason_id_unique', label: NODE.DENIAL_REASON },
];

/**
 * Creates the graph's uniqueness constraints. `IF NOT EXISTS` makes repeat
 * calls safe, so this can run at the start of every load.
 *
 * TODO(Enterprise upgrade): Code should be keyed on (system, code), but Neo4j
 * Community supports neither node-key nor composite-uniqueness constraints —
 * only Enterprise does. Until then, write.ts must always MERGE Code nodes on
 * both properties together, and validate.ts checks for duplicate
 * (system, code) pairs as a backstop.
 *
 * (Requirement)-[:DIAGNOSIS_OF]-> and [:FAILS_AS]-> remain deliberately
 * unimplemented (see CLAUDE.md "Graph model"). APPLIES_TO landed 2026-08-22
 * for the narrower stated-grouping case: a policy whose code tables are
 * headed by the stance statement itself (Cigna) states the code↔statement
 * link, so recording it is a fact, not an inference. MAC documents do not
 * state it, so the MAC dialect never emits APPLIES_TO.
 */
export async function ensureConstraints(graph: Graph): Promise<void> {
  for (const { name, label } of UNIQUENESS_CONSTRAINTS) {
    await graph.run(
      `CREATE CONSTRAINT ${name} IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`,
    );
  }
}
