import type { Role } from "@modeldock/core";

export type Permission =
  | "system:read"
  | "models:read"
  | "models:pull"
  | "models:delete"
  | "models:probe"
  | "network:read"
  | "diagnostics:run"
  | "audit:read";

const rolePermissions: Record<Role, Permission[]> = {
  admin: [
    "system:read",
    "models:read",
    "models:pull",
    "models:delete",
    "models:probe",
    "network:read",
    "diagnostics:run",
    "audit:read"
  ],
  operator: ["system:read", "models:read", "models:probe", "network:read", "diagnostics:run", "audit:read"],
  viewer: ["system:read", "models:read", "network:read", "audit:read"]
};

export function permissionsFor(role: Role): Permission[] {
  return [...rolePermissions[role]];
}

export function can(role: Role, permission: Permission): boolean {
  return rolePermissions[role].includes(permission);
}

export * from "./model-access.js";
