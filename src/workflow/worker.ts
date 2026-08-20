import { fileURLToPath } from 'node:url';

import { NativeConnection, Worker } from '@temporalio/worker';

import { loadTemporalConfig } from './config.ts';
import * as activities from './activities.ts';

/** Connects to Temporal and polls the review task queue until the process is killed. */
export async function runWorker(): Promise<void> {
  const { address, namespace, taskQueue } = loadTemporalConfig();

  const connection = await NativeConnection.connect({ address });
  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('./review.workflow.ts', import.meta.url)),
      activities,
    });

    process.stderr.write(`worker polling ${taskQueue} on ${namespace}\n`);
    await worker.run();
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runWorker();
}
