import type { Model, SystemResources } from "../api.js";
import { formatBytes } from "./format.js";

export function getModelFit(model: Model, resources?: SystemResources): { label: string; tone: "info" | "warn" | "bad"; title: string } {
  const freeBytes = resources?.memory.freeBytes;
  const estimatedRequiredBytes = model.sizeBytes * 1.25;

  if (!freeBytes) {
    return {
      label: "Usable",
      tone: "info",
      title: "Waiting for memory telemetry"
    };
  }

  if (estimatedRequiredBytes <= freeBytes * 0.75) {
    return {
      label: "Usable",
      tone: "info",
      title: `Estimated need ${formatBytes(estimatedRequiredBytes)}; free RAM ${formatBytes(freeBytes)}`
    };
  }

  if (estimatedRequiredBytes <= freeBytes) {
    return {
      label: "Overload risk",
      tone: "warn",
      title: `Estimated need ${formatBytes(estimatedRequiredBytes)}; free RAM ${formatBytes(freeBytes)}`
    };
  }

  return {
    label: "Too big",
    tone: "bad",
    title: `Estimated need ${formatBytes(estimatedRequiredBytes)}; free RAM ${formatBytes(freeBytes)}`
  };
}
