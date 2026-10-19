import type { Role } from "@modeldock/core";

export type Permission =
  | "system:read"
  | "models:read"
  | "models:pull"
  | "models:delete"
  | "models:probe"
  | "network:read"
  | "diagnostics:run"
  | "audit:read"
  | "chat:use"
  | "accounts:manage";

const rolePermissions: Record<Role, Permission[]> = {
  admin: [
    "system:read",
    "models:read",
    "models:pull",
    "models:delete",
    "models:probe",
    "network:read",
    "diagnostics:run",
    "audit:read",
    "chat:use",
    "accounts:manage"
  ],
  operator: ["system:read", "models:read", "models:probe", "network:read", "diagnostics:run", "audit:read", "chat:use"],
  viewer: ["system:read", "models:read", "network:read", "audit:read", "chat:use"],
  member: ["models:read", "chat:use"]
};

export function permissionsFor(role: Role): Permission[] {
  return [...rolePermissions[role]];
}

export function can(role: Role, permission: Permission): boolean {
  return rolePermissions[role].includes(permission);
}

export * from "./model-access.ts";
export * from "./accounts.ts";
export * from "./api-keys.ts";
export * from "./quick-commands.ts";
