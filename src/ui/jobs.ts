import { randomUUID } from 'node:crypto';

export type JobStatus = 'extracting' | 'starting-review' | 'attached' | 'failed';

export interface Job {
  readonly id: string;
  readonly lcdId: string;
  readonly articleId?: string;
  status: JobStatus;
  workflowId?: string;
  error?: string;
  readonly createdAt: string;
}

export class JobStore {
  private jobs: Map<string, Job> = new Map();
  private jobsByLcdId: Map<string, string> = new Map(); // lcdId -> job id

  create(lcdId: string, articleId: string | undefined, now: () => string): Job {
    const existingJobId = this.jobsByLcdId.get(lcdId);
    if (existingJobId) {
      const existing = this.jobs.get(existingJobId);
      if (existing && (existing.status === 'extracting' || existing.status === 'starting-review')) {
        return existing;
      }
    }

    const id = randomUUID();
    const job: Job = {
      id,
      lcdId,
      ...(articleId !== undefined ? { articleId } : {}),
      status: 'extracting',
      createdAt: now(),
    };

    this.jobs.set(id, job);
    this.jobsByLcdId.set(lcdId, id);

    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return Array.from(this.jobs.values());
  }

  markStartingReview(id: string): void {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`unknown job: ${id}`);
    }
    if (job.status !== 'extracting') {
      throw new Error(`wrong prior state: expected 'extracting', got '${job.status}'`);
    }
    job.status = 'starting-review';
  }

  markAttached(id: string, workflowId: string): void {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`unknown job: ${id}`);
    }
    if (job.status !== 'starting-review') {
      throw new Error(`wrong prior state: expected 'starting-review', got '${job.status}'`);
    }
    job.status = 'attached';
    job.workflowId = workflowId;
  }

  markFailed(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`unknown job: ${id}`);
    }
    job.status = 'failed';
    job.error = error;
  }
}
