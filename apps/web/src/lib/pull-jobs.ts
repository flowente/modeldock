import type { ModelPullJob } from "../api.js";

export function isPullJobActive(job: ModelPullJob | undefined): boolean {
  return job?.status === "queued" || job?.status === "running";
}

export function isPullJobTerminal(job: ModelPullJob | undefined): boolean {
  return job?.status === "succeeded" || job?.status === "failed";
}

export function getPullPercentage(job: ModelPullJob | undefined): number | null {
  if (!job?.completedBytes || !job.totalBytes || job.totalBytes <= 0) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round((job.completedBytes / job.totalBytes) * 100)));
}

export function getPullFeedback({
  deleteFailed,
  fallbackMessage,
  isStarting,
  pullFailed,
  pullJob
}: {
  deleteFailed: boolean;
  fallbackMessage: string | null;
  isStarting: boolean;
  pullFailed: boolean;
  pullJob?: ModelPullJob;
}): string {
  if (isStarting) {
    return "Starting pull…";
  }

  if (pullJob?.status === "failed") {
    return `${pullJob.model}: Pull failed`;
  }

  if (pullJob?.status === "succeeded") {
    return `${pullJob.model}: Pull completed`;
  }

  if (pullJob && isPullJobActive(pullJob)) {
    return `${pullJob.model}: ${pullJob.message}`;
  }

  if (pullFailed) {
    return "Pull failed";
  }

  if (deleteFailed) {
    return "Delete failed";
  }

  return fallbackMessage ?? "";
}
