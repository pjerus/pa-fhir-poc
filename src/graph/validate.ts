import type { Graph } from './db.ts';
import { NODE, REL } from './schema.ts';

/**
 * Structural graph checks that a review process can't easily see by eye.
 * These are backstops for things Neo4j Community can't enforce as
 * constraints (Code's composite key) or that no constraint could ever
 * express (text duplication, relationship cycles, dangling references).
 */
export type IssueKind =
  | 'duplicate-requirement-text'
  | 'orphan-code'
  | 'orphan-denial-reason'
  | 'requirement-cycle'
  | 'duplicate-code-pair';

export interface ValidationIssue {
  readonly kind: IssueKind;
  readonly detail: string;
}

export interface ValidationReport {
  readonly clean: boolean;
  readonly issues: ValidationIssue[];
}

/** Requirement cycles longer than this are not searched for; a POC-scale graph never needs it. */
const MAX_CYCLE_DEPTH = 10;

/**
 * Runs every structural check over the whole graph (no lcdId filter) and
 * returns the combined report. Pure read: never mutates the graph.
 */
export async function validateGraph(graph: Graph): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [
    ...(await findDuplicateRequirementText(graph)),
    ...(await findOrphanCodes(graph)),
    ...(await findOrphanDenialReasons(graph)),
    ...(await findRequirementCycles(graph)),
    ...(await findDuplicateCodePairs(graph)),
  ];
  return { clean: issues.length === 0, issues };
}

async function findDuplicateRequirementText(graph: Graph): Promise<ValidationIssue[]> {
  const rows = await graph.run(`
    MATCH (lcd:${NODE.LCD})-[:${REL.REQUIRES}]->(r1:${NODE.REQUIREMENT})
    MATCH (lcd)-[:${REL.REQUIRES}]->(r2:${NODE.REQUIREMENT})
    WHERE r1.id < r2.id AND r1.text = r2.text
    RETURN lcd.id AS lcdId, r1.id AS id1, r2.id AS id2, r1.text AS text
  `);
  return rows.map((row) => ({
    kind: 'duplicate-requirement-text',
    detail: `Requirements ${row.id1 as string} and ${row.id2 as string} under LCD ${row.lcdId as string} have identical text: "${row.text as string}"`,
  }));
}

async function findOrphanCodes(graph: Graph): Promise<ValidationIssue[]> {
  const rows = await graph.run(`
    MATCH (c:${NODE.CODE})
    WHERE NOT (()-[:${REL.COVERS}]->(c)) AND NOT (()-[:${REL.LISTS}]->(c)) AND NOT (()-[:${REL.APPLIES_TO}]->(c))
    RETURN c.system AS system, c.code AS code
  `);
  return rows.map((row) => ({
    kind: 'orphan-code',
    detail: `Code ${row.system as string}/${row.code as string} has no incoming COVERS, LISTS, or APPLIES_TO relationship`,
  }));
}

async function findOrphanDenialReasons(graph: Graph): Promise<ValidationIssue[]> {
  const rows = await graph.run(`
    MATCH (d:${NODE.DENIAL_REASON})
    WHERE NOT (()-[:${REL.DEFINES}]->(d))
    RETURN d.id AS id
  `);
  return rows.map((row) => ({
    kind: 'orphan-denial-reason',
    detail: `DenialReason ${row.id as string} has no incoming DEFINES relationship`,
  }));
}

async function findRequirementCycles(graph: Graph): Promise<ValidationIssue[]> {
  const rows = await graph.run(`
    MATCH p = (r:${NODE.REQUIREMENT})-[*1..${MAX_CYCLE_DEPTH}]->(r)
    WHERE all(n IN nodes(p) WHERE n:${NODE.REQUIREMENT})
    RETURN [n IN nodes(p) | n.id] AS ids
  `);

  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const row of rows) {
    const ids = row.ids as string[];
    // Drop the closing node (== the starting node) before canonicalizing, so
    // the same cycle found from different starting points/directions dedupes.
    const key = [...ids.slice(0, -1)].sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({
      kind: 'requirement-cycle',
      detail: `Requirement cycle detected: ${ids.join(' -> ')}`,
    });
  }
  return issues;
}

async function findDuplicateCodePairs(graph: Graph): Promise<ValidationIssue[]> {
  const rows = await graph.run(`
    MATCH (c1:${NODE.CODE}), (c2:${NODE.CODE})
    WHERE c1.system = c2.system AND c1.code = c2.code AND elementId(c1) < elementId(c2)
    RETURN c1.system AS system, c1.code AS code
  `);
  return rows.map((row) => ({
    kind: 'duplicate-code-pair',
    detail: `Duplicate Code nodes for system=${row.system as string} code=${row.code as string}`,
  }));
}
