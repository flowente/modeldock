import type { ComponentHealth, TailnetDevice } from "../api.js";

export function formatHealthStatus(status: ComponentHealth["status"] | undefined): string {
  if (!status) {
    return "Loading";
  }

  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatOnlineStatus(online: TailnetDevice["online"]): string {
  if (online === true) {
    return "Online";
  }

  if (online === false) {
    return "Offline";
  }

  return "Unknown";
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

export function formatReadableDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

export function formatBytes(value: number) {
  if (value === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(1)} ${units[index]}`;
}
