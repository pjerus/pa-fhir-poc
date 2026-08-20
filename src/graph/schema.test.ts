import test from 'node:test';
import assert from 'node:assert/strict';

import { loadGraphConfig } from './config.ts';
import { createGraph } from './db.ts';
import { NODE, ensureConstraints } from './schema.ts';

test('ensureConstraints creates the four uniqueness constraints and is idempotent', async () => {
  const graph = createGraph(loadGraphConfig());

  try {
    await ensureConstraints(graph);
    await ensureConstraints(graph); // must not throw the second time

    const rows = await graph.run('SHOW CONSTRAINTS');
    const uniqueness = rows
      .filter((row) => row.type === 'UNIQUENESS')
      .map((row) => ({ label: (row.labelsOrTypes as string[])[0], properties: row.properties as string[] }));

    for (const label of [NODE.LCD, NODE.ARTICLE, NODE.REQUIREMENT, NODE.DENIAL_REASON]) {
      assert.ok(
        uniqueness.some((row) => row.label === label && row.properties.length === 1 && row.properties[0] === 'id'),
        `expected a uniqueness constraint on ${label}.id`,
      );
    }

    // Community edition supports neither node keys nor composite uniqueness
    // constraints (see schema.ts TODO), so Code must not have one here.
    assert.ok(
      !uniqueness.some((row) => row.label === NODE.CODE),
      'Code should not have a uniqueness constraint on Community edition',
    );
  } finally {
    await graph.close();
  }
});

test('createGraph surfaces an actionable error when Neo4j is unreachable', async () => {
  const config = { ...loadGraphConfig(), uri: 'bolt://localhost:19999' };
  const graph = createGraph(config);

  try {
    await assert.rejects(
      () => graph.run('RETURN 1'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Cannot reach Neo4j at bolt:\/\/localhost:19999/);
        assert.match(error.message, new RegExp(`db ${config.database}`));
        assert.match(error.message, /docker compose up -d/);
        return true;
      },
    );
  } finally {
    await graph.close();
  }
});
