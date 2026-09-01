import type { ModelPullJob } from "../api.js";
import type { LanguagePreference } from "../types.js";

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
  pullJob,
  language = "en"
}: {
  deleteFailed: boolean;
  fallbackMessage: string | null;
  isStarting: boolean;
  pullFailed: boolean;
  pullJob?: ModelPullJob;
  language?: LanguagePreference;
}): string {
  if (isStarting) {
    return language === "it" ? "Avvio del download…" : "Starting pull…";
  }

  if (pullJob?.status === "failed") {
    return `${pullJob.model}: ${language === "it" ? "Download non riuscito" : "Pull failed"}`;
  }

  if (pullJob?.status === "succeeded") {
    return `${pullJob.model}: ${language === "it" ? "Download completato" : "Pull completed"}`;
  }

  if (pullJob && isPullJobActive(pullJob)) {
    return `${pullJob.model}: ${pullJob.message}`;
  }

  if (pullFailed) {
    return language === "it" ? "Download non riuscito" : "Pull failed";
  }

  if (deleteFailed) {
    return language === "it" ? "Eliminazione non riuscita" : "Delete failed";
  }

  return fallbackMessage ?? "";
}
