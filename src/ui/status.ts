import type { Job, JobStatus } from './jobs.ts';
import type { ReviewStatus } from '../workflow/review.workflow.ts';
import type { WorkflowRuntimeStatus } from '../workflow/client.ts';

export interface WorkflowSnapshot {
  readonly workflowId: string;
  readonly status: WorkflowRuntimeStatus;
  readonly reviewStatus?: ReviewStatus | 'worker-unavailable'; // present when RUNNING
  readonly outcome?: 'approved' | 'rejected'; // present when COMPLETED
  readonly failureReason?: string; // present when FAILED/TERMINATED/TIMED_OUT
}

export type Phase = JobStatus | ReviewStatus | 'worker-unavailable' | 'approved' | 'rejected' | 'workflow-failed';

export interface StatusEntry {
  readonly lcdId: string;
  readonly jobId?: string;
  readonly workflowId?: string;
  readonly phase: Exclude<Phase, 'attached'>;
  readonly error?: string;
}

export function mergeStatus(jobs: readonly Job[], workflows: readonly WorkflowSnapshot[]): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const workflowsByJobWorkflowId = new Map<string, WorkflowSnapshot>();

  // Index workflows by workflowId
  for (const workflow of workflows) {
    workflowsByJobWorkflowId.set(workflow.workflowId, workflow);
  }

  // Track which workflows have been matched to jobs
  const matchedWorkflowIds = new Set<string>();

  // Process each job
  for (const job of jobs) {
    if (job.status === 'failed') {
      entries.push({
        lcdId: job.lcdId,
        jobId: job.id,
        phase: 'failed',
        ...(job.error && { error: job.error }),
      } as StatusEntry);
    } else if (job.status === 'extracting' || job.status === 'starting-review') {
      entries.push({
        lcdId: job.lcdId,
        jobId: job.id,
        phase: job.status,
      });
    } else if (job.status === 'attached' && job.workflowId) {
      // Look up the workflow
      const workflow = workflowsByJobWorkflowId.get(job.workflowId);
      matchedWorkflowIds.add(job.workflowId);

      if (workflow) {
        const phase = workflowToPhase(workflow);
        const failureReason = phase === 'workflow-failed' ? workflow.failureReason : undefined;

        entries.push({
          lcdId: job.lcdId,
          jobId: job.id,
          workflowId: job.workflowId,
          phase,
          ...(failureReason && { error: failureReason }),
        } as StatusEntry);
      } else {
        // Workflow not found (shouldn't happen, but handle gracefully)
        entries.push({
          lcdId: job.lcdId,
          jobId: job.id,
          workflowId: job.workflowId,
          phase: 'workflow-failed',
          error: 'workflow not found',
        });
      }
    }
  }

  // Process unmatched workflows (server restart scenario)
  for (const workflow of workflows) {
    if (!matchedWorkflowIds.has(workflow.workflowId)) {
      const lcdId = stripReviewPrefix(workflow.workflowId);
      const phase = workflowToPhase(workflow);
      const failureReason = phase === 'workflow-failed' ? workflow.failureReason : undefined;

      entries.push({
        lcdId,
        workflowId: workflow.workflowId,
        phase,
        ...(failureReason && { error: failureReason }),
      } as StatusEntry);
    }
  }

  return entries;
}

function workflowToPhase(workflow: WorkflowSnapshot): Exclude<Phase, 'attached'> {
  if (workflow.status === 'RUNNING') {
    if (workflow.reviewStatus === undefined) {
      throw new Error(`RUNNING workflow "${workflow.workflowId}" has no reviewStatus — the caller must query it.`);
    }
    return workflow.reviewStatus;
  }
  if (workflow.status === 'COMPLETED') {
    if (workflow.outcome === undefined) {
      throw new Error(`COMPLETED workflow "${workflow.workflowId}" has no outcome — the caller must fetch its result.`);
    }
    return workflow.outcome;
  }
  // FAILED, CANCELLED, TERMINATED, CONTINUED_AS_NEW, TIMED_OUT
  return 'workflow-failed';
}

// Workflow ids are exactly `review-${lcdId}` (src/workflow/client.ts).
function stripReviewPrefix(workflowId: string): string {
  return workflowId.startsWith('review-') ? workflowId.slice('review-'.length) : workflowId;
}
