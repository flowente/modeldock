import type { ComponentHealth } from "../api.js";

export function getStringHealthDetail(health: ComponentHealth | undefined, key: string): string | undefined {
  const value = health?.details?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getStringArrayHealthDetail(health: ComponentHealth | undefined, key: string): string[] {
  const value = health?.details?.[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
