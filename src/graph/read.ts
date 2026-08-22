import type { Graph } from './db.ts';
import { NODE, REL } from './schema.ts';
import type { CodeRef, DenialReason, LcdStatus, Requirement } from '../types.ts';

export interface ApprovedSubgraph {
  readonly lcd: {
    readonly id: string;
    readonly title?: string;
    readonly version?: string;
    readonly status: LcdStatus;
    readonly sourceHash: string;
  };
  readonly requirements: readonly Requirement[];
  readonly coveredCodes: readonly CodeRef[];
  readonly article?: {
    readonly id: string;
    readonly sourceHash: string;
    readonly listedCodes: readonly CodeRef[];
    readonly denialReasons: readonly DenialReason[];
  };
}

/**
 * Reads the subgraph for one LCD regardless of status.
 * Used by the review screen to inspect draft or approved content.
 */
export async function readSubgraph(graph: Graph, lcdId: string): Promise<ApprovedSubgraph> {
  const [lcdRow] = await graph.run(`MATCH (lcd:${NODE.LCD} {id: $lcdId}) RETURN properties(lcd) AS lcd`, {
    lcdId,
  });
  if (lcdRow === undefined) {
    throw new Error(`LCD "${lcdId}" not found in the graph — run: node cli.ts load ${lcdId}`);
  }

  const lcd = lcdRow.lcd as {
    id: string;
    title?: string;
    version?: string;
    status: LcdStatus;
    sourceHash: string;
  };

  const requirementRows = await graph.run(
    `
    MATCH (:${NODE.LCD} {id: $lcdId})-[:${REL.REQUIRES}]->(r:${NODE.REQUIREMENT})
    RETURN properties(r) AS r
    ORDER BY r.ordinal
    `,
    { lcdId },
  );
  const requirements = requirementRows.map((row) => row.r as Requirement);

  const codeRows = await graph.run(
    `
    MATCH (:${NODE.LCD} {id: $lcdId})-[:${REL.COVERS}]->(c:${NODE.CODE})
    RETURN c.system AS system, c.code AS code
    `,
    { lcdId },
  );
  const coveredCodes = codeRows.map((row) => ({ system: row.system as string, code: row.code as string }));

  const [articleRow] = await graph.run(
    `
    MATCH (:${NODE.LCD} {id: $lcdId})-[:${REL.HAS_ARTICLE}]->(article:${NODE.ARTICLE})
    RETURN properties(article) AS article
    `,
    { lcdId },
  );

  let article: ApprovedSubgraph['article'];
  if (articleRow !== undefined) {
    const articleProps = articleRow.article as { id: string; sourceHash: string };

    const listedCodeRows = await graph.run(
      `
      MATCH (:${NODE.ARTICLE} {id: $articleId})-[:${REL.LISTS}]->(c:${NODE.CODE})
      RETURN c.system AS system, c.code AS code
      `,
      { articleId: articleProps.id },
    );
    const listedCodes = listedCodeRows.map((row) => ({ system: row.system as string, code: row.code as string }));

    const denialReasonRows = await graph.run(
      `
      MATCH (:${NODE.ARTICLE} {id: $articleId})-[:${REL.DEFINES}]->(d:${NODE.DENIAL_REASON})
      RETURN properties(d) AS d
      `,
      { articleId: articleProps.id },
    );
    const denialReasons = denialReasonRows.map((row) => row.d as DenialReason);

    article = {
      id: articleProps.id,
      sourceHash: articleProps.sourceHash,
      listedCodes,
      denialReasons,
    };
  }

  return {
    lcd: {
      id: lcd.id,
      ...(lcd.title !== undefined && lcd.title !== null ? { title: lcd.title } : {}),
      ...(lcd.version !== undefined && lcd.version !== null ? { version: lcd.version } : {}),
      status: lcd.status,
      sourceHash: lcd.sourceHash,
    },
    requirements,
    coveredCodes,
    ...(article !== undefined ? { article } : {}),
  };
}

/**
 * Reads the approved subgraph for one LCD: requirements ordered by ordinal,
 * covered codes, and (if the LCD has one) its paired article. This is the
 * read side M4's FHIR projection leans on — it never returns a draft LCD.
 */
export async function readApprovedSubgraph(graph: Graph, lcdId: string): Promise<ApprovedSubgraph> {
  const subgraph = await readSubgraph(graph, lcdId);
  if (subgraph.lcd.status !== 'approved') {
    throw new Error(
      `LCD "${subgraph.lcd.id}" is not approved (status: "${subgraph.lcd.status}") — its review has not been approved.`,
    );
  }
  return subgraph;
}
