import type { ComponentHealth, TailnetDevice } from "../api.js";
import type { LanguagePreference } from "../types.js";

export function formatHealthStatus(status: ComponentHealth["status"] | undefined, language: LanguagePreference = "en"): string {
  if (!status) {
    return language === "it" ? "Caricamento" : "Loading";
  }

  if (language === "it") {
    const labels: Record<ComponentHealth["status"], string> = {
      available: "Disponibile",
      degraded: "Da verificare",
      not_configured: "Non configurato",
      unavailable: "Non disponibile",
      unknown: "Sconosciuto"
    };

    return labels[status];
  }

  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatOnlineStatus(online: TailnetDevice["online"], language: LanguagePreference = "en"): string {
  if (online === true) {
    return language === "it" ? "Connesso" : "Online";
  }

  if (online === false) {
    return language === "it" ? "Disconnesso" : "Offline";
  }

  return language === "it" ? "Sconosciuto" : "Unknown";
}

export function getDeviceStatusTone(online: TailnetDevice["online"]): "online" | "offline" | "unknown" {
  if (online === true) {
    return "online";
  }

  if (online === false) {
    return "offline";
  }

  return "unknown";
}

export function formatReadableDate(value: string, language: LanguagePreference = "en"): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(language === "it" ? "it-IT" : "en-US");
}

export function formatHealthSummary(
  label: string,
  status: ComponentHealth["status"] | undefined,
  language: LanguagePreference
): string {
  if (language !== "it") {
    if (!status) return `${label} status is loading.`;
    if (status === "available") return `${label} is available.`;
    if (status === "not_configured") return `${label} is not configured yet.`;
    if (status === "unavailable") return `${label} is not reachable.`;
    return `${label} needs attention.`;
  }

  if (!status) return `Caricamento dello stato di ${label}.`;
  if (status === "available") return `${label} è disponibile.`;
  if (status === "not_configured") return `${label} non è ancora configurato.`;
  if (status === "unavailable") return `${label} non è raggiungibile.`;
  return `${label} richiede attenzione.`;
}

export function formatBytes(value: number) {
  if (value === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(1)} ${units[index]}`;
}
