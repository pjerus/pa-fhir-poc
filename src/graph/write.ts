import type { Graph } from './db.ts';
import { NODE, REL } from './schema.ts';
import type { ArticleInput, LcdInput } from '../types.ts';

export interface LoadSubgraphInput {
  readonly lcd: LcdInput;
  readonly article?: ArticleInput;
}

/**
 * Upserts an LCD (and, if present, its paired article) into the graph.
 * Idempotent: re-running with the same input creates no duplicate nodes or
 * edges, and edges to anything the input no longer mentions are removed.
 */
export async function loadSubgraph(graph: Graph, input: LoadSubgraphInput): Promise<void> {
  const { lcd, article } = input;

  await upsertLcd(graph, lcd);
  await upsertRequirements(graph, lcd);
  await upsertCoveredCodes(graph, lcd);
  await cleanupStaleRequires(graph, lcd);
  await cleanupStaleCovers(graph, lcd);

  if (article !== undefined) {
    await upsertArticle(graph, lcd.id, article);
    await upsertListedCodes(graph, article);
    await upsertDenialReasons(graph, article);
    await cleanupStaleLists(graph, article);
    await cleanupStaleDefines(graph, article);
  }
}

async function upsertLcd(graph: Graph, lcd: LcdInput): Promise<void> {
  await graph.run(
    `
    MERGE (lcd:${NODE.LCD} {id: $id})
    ON CREATE SET
      lcd.status = 'draft',
      lcd.sourceHash = $sourceHash,
      lcd.title = $title,
      lcd.version = $version
    ON MATCH SET
      lcd.status = CASE WHEN lcd.sourceHash = $sourceHash THEN lcd.status ELSE 'draft' END,
      lcd.sourceHash = $sourceHash,
      lcd.title = $title,
      lcd.version = $version
    `,
    { id: lcd.id, sourceHash: lcd.sourceHash, title: lcd.title ?? null, version: lcd.version ?? null },
  );
}

async function upsertRequirements(graph: Graph, lcd: LcdInput): Promise<void> {
  await graph.run(
    `
    MATCH (lcd:${NODE.LCD} {id: $lcdId})
    UNWIND $requirements AS req
    MERGE (r:${NODE.REQUIREMENT} {id: req.id})
    SET r.text = req.text, r.ordinal = req.ordinal, r.category = req.category
    MERGE (lcd)-[:${REL.REQUIRES}]->(r)
    `,
    { lcdId: lcd.id, requirements: lcd.requirements },
  );
}

async function upsertCoveredCodes(graph: Graph, lcd: LcdInput): Promise<void> {
  await graph.run(
    `
    MATCH (lcd:${NODE.LCD} {id: $lcdId})
    UNWIND $codes AS code
    MERGE (c:${NODE.CODE} {system: code.system, code: code.code})
    MERGE (lcd)-[:${REL.COVERS}]->(c)
    `,
    { lcdId: lcd.id, codes: lcd.coveredCodes },
  );
}

async function cleanupStaleRequires(graph: Graph, lcd: LcdInput): Promise<void> {
  await graph.run(
    `
    MATCH (lcd:${NODE.LCD} {id: $lcdId})-[rel:${REL.REQUIRES}]->(r:${NODE.REQUIREMENT})
    WHERE NOT r.id IN $requirementIds
    DELETE rel
    `,
    { lcdId: lcd.id, requirementIds: lcd.requirements.map((requirement) => requirement.id) },
  );
}

async function cleanupStaleCovers(graph: Graph, lcd: LcdInput): Promise<void> {
  await graph.run(
    `
    MATCH (lcd:${NODE.LCD} {id: $lcdId})-[rel:${REL.COVERS}]->(c:${NODE.CODE})
    WHERE NOT any(code IN $codes WHERE code.system = c.system AND code.code = c.code)
    DELETE rel
    `,
    { lcdId: lcd.id, codes: lcd.coveredCodes },
  );
}

async function upsertArticle(graph: Graph, lcdId: string, article: ArticleInput): Promise<void> {
  await graph.run(
    `
    MATCH (lcd:${NODE.LCD} {id: $lcdId})
    MERGE (article:${NODE.ARTICLE} {id: $id})
    SET article.sourceHash = $sourceHash, article.title = $title, article.version = $version
    MERGE (lcd)-[:${REL.HAS_ARTICLE}]->(article)
    `,
    {
      lcdId,
      id: article.id,
      sourceHash: article.sourceHash,
      title: article.title ?? null,
      version: article.version ?? null,
    },
  );
}

async function upsertListedCodes(graph: Graph, article: ArticleInput): Promise<void> {
  await graph.run(
    `
    MATCH (article:${NODE.ARTICLE} {id: $articleId})
    UNWIND $codes AS code
    MERGE (c:${NODE.CODE} {system: code.system, code: code.code})
    MERGE (article)-[:${REL.LISTS}]->(c)
    `,
    { articleId: article.id, codes: article.listedCodes },
  );
}

async function upsertDenialReasons(graph: Graph, article: ArticleInput): Promise<void> {
  await graph.run(
    `
    MATCH (article:${NODE.ARTICLE} {id: $articleId})
    UNWIND $denialReasons AS dr
    MERGE (d:${NODE.DENIAL_REASON} {id: dr.id})
    SET d.text = dr.text
    MERGE (article)-[:${REL.DEFINES}]->(d)
    `,
    { articleId: article.id, denialReasons: article.denialReasons },
  );
}

async function cleanupStaleLists(graph: Graph, article: ArticleInput): Promise<void> {
  await graph.run(
    `
    MATCH (article:${NODE.ARTICLE} {id: $articleId})-[rel:${REL.LISTS}]->(c:${NODE.CODE})
    WHERE NOT any(code IN $codes WHERE code.system = c.system AND code.code = c.code)
    DELETE rel
    `,
    { articleId: article.id, codes: article.listedCodes },
  );
}

async function cleanupStaleDefines(graph: Graph, article: ArticleInput): Promise<void> {
  await graph.run(
    `
    MATCH (article:${NODE.ARTICLE} {id: $articleId})-[rel:${REL.DEFINES}]->(d:${NODE.DENIAL_REASON})
    WHERE NOT d.id IN $denialReasonIds
    DELETE rel
    `,
    { articleId: article.id, denialReasonIds: article.denialReasons.map((reason) => reason.id) },
  );
}
