import type { Model, SystemResources } from "../api.js";
import type { LanguagePreference } from "../types.js";
import { formatBytes } from "./format.js";

export function getModelFit(model: Model, resources?: SystemResources, language: LanguagePreference = "en"): { label: string; tone: "info" | "warn" | "bad"; title: string } {
  const freeBytes = resources?.memory.freeBytes;
  const estimatedRequiredBytes = model.sizeBytes * 1.25;

  if (!freeBytes) {
    return {
      label: language === "it" ? "Utilizzabile" : "Usable",
      tone: "info",
      title: language === "it" ? "In attesa dei dati sulla memoria" : "Waiting for memory telemetry"
    };
  }

  if (estimatedRequiredBytes <= freeBytes * 0.75) {
    return {
      label: language === "it" ? "Utilizzabile" : "Usable",
      tone: "info",
      title: language === "it"
        ? `Memoria stimata ${formatBytes(estimatedRequiredBytes)}; RAM libera ${formatBytes(freeBytes)}`
        : `Estimated need ${formatBytes(estimatedRequiredBytes)}; free RAM ${formatBytes(freeBytes)}`
    };
  }

  if (estimatedRequiredBytes <= freeBytes) {
    return {
      label: language === "it" ? "Rischio sovraccarico" : "Overload risk",
      tone: "warn",
      title: language === "it"
        ? `Memoria stimata ${formatBytes(estimatedRequiredBytes)}; RAM libera ${formatBytes(freeBytes)}`
        : `Estimated need ${formatBytes(estimatedRequiredBytes)}; free RAM ${formatBytes(freeBytes)}`
    };
  }

  return {
    label: language === "it" ? "Troppo grande" : "Too big",
    tone: "bad",
    title: language === "it"
      ? `Memoria stimata ${formatBytes(estimatedRequiredBytes)}; RAM libera ${formatBytes(freeBytes)}`
      : `Estimated need ${formatBytes(estimatedRequiredBytes)}; free RAM ${formatBytes(freeBytes)}`
  };
}
