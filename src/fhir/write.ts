import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadGraphConfig } from '../graph/config.ts';
import { createGraph } from '../graph/db.ts';
import { readApprovedSubgraph } from '../graph/read.ts';
import { projectLcd } from './project.ts';

// Deliberately cwd-relative, matching the CLI's original behavior — the test
// suites isolate runs by spawning from a temp cwd and reading out/ inside it.
export const OUT_DIR = 'out';

export interface ProjectedArtifacts {
  readonly paths: { readonly crd: string; readonly dtr: string; readonly planDefinition: string };
  readonly artifacts: { readonly crd: unknown; readonly dtr: unknown; readonly planDefinition: unknown };
}

/** Projects an approved LCD's subgraph to the three FHIR artifacts and writes them to `OUT_DIR`. */
export async function projectAndWrite(lcdId: string): Promise<ProjectedArtifacts> {
  const graph = createGraph(loadGraphConfig());
  try {
    const subgraph = await readApprovedSubgraph(graph, lcdId);
    const { crd, dtr, planDefinition } = projectLcd(subgraph);

    await mkdir(OUT_DIR, { recursive: true });
    const paths = {
      crd: join(OUT_DIR, `${lcdId}.crd.json`),
      dtr: join(OUT_DIR, `${lcdId}.dtr.json`),
      planDefinition: join(OUT_DIR, `${lcdId}.plandefinition.json`),
    };
    await writeFile(paths.crd, `${JSON.stringify(crd, null, 2)}\n`, 'utf8');
    await writeFile(paths.dtr, `${JSON.stringify(dtr, null, 2)}\n`, 'utf8');
    await writeFile(paths.planDefinition, `${JSON.stringify(planDefinition, null, 2)}\n`, 'utf8');

    return { paths, artifacts: { crd, dtr, planDefinition } };
  } finally {
    await graph.close();
  }
}
