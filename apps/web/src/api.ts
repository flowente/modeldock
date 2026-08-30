export interface ComponentHealth {
  name: string;
  status: "available" | "degraded" | "unavailable" | "unknown" | "not_configured";
  message: string;
  checkedAt: string;
  details?: Record<string, unknown>;
}

export interface SystemStatus {
  overall: "ok" | "degraded" | "fail";
  checkedAt: string;
  components: {
    backend: ComponentHealth;
    storage: ComponentHealth;
    ollama: ComponentHealth;
    tailscale: ComponentHealth;
    openWebUI: ComponentHealth;
  };
  warnings: string[];
}

export interface SystemResources {
  checkedAt: string;
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedRatio: number;
  };
  gpu: {
    status: "not_configured" | "not_detected" | "available";
    message: string;
  };
  inferenceProjection: {
    tokensPerSecond: {
      min: number;
      max: number;
    };
    confidence: "fake" | "estimated" | "measured";
    message: string;
  };
}

export interface Model {
  name: string;
  tag: string;
  sizeBytes: number;
  modifiedAt?: string;
  running: boolean;
}

export interface ModelPullProgress {
  model: string;
  status: string;
  completedBytes?: number;
  totalBytes?: number;
}

export interface ModelPullJob {
  id: string;
  model: string;
  status: "queued" | "running" | "succeeded" | "failed";
  message: string;
  completedBytes?: number;
  totalBytes?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccessGroup {
  id: string;
  name: string;
  description?: string;
}

export interface AccessUser {
  id: string;
  displayName: string;
  role: "admin" | "operator" | "viewer";
  groupIds: string[];
}

export interface ModelAccessGrant {
  subject: {
    type: "user" | "group";
    id: string;
  };
  canUse: boolean;
}

export interface ModelAccessPolicy {
  modelName: string;
  enabled: boolean;
  loaded: boolean;
  grants: ModelAccessGrant[];
}

export interface ModelAccessMatrix {
  users: AccessUser[];
  groups: AccessGroup[];
  models: ModelAccessPolicy[];
}

export interface UpdateModelAccessPolicyInput {
  modelName: string;
  enabled?: boolean;
  loaded?: boolean;
  groupGrants?: Record<string, boolean>;
}

export interface TailnetDevice {
  id: string;
  hostname: string;
  addresses: string[];
  online: boolean | "unknown";
  authorized: boolean;
  os?: string;
  lastSeen?: string;
}

export interface DiagnosticCheck {
  id: string;
  label: string;
}

export interface DiagnosticCheckResult extends DiagnosticCheck {
  status: "pass" | "warn" | "fail" | "skipped";
  message: string;
  durationMs: number;
  timestamp: string;
  suggestion?: string | null;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actorId: string;
  action: string;
  module: string;
  result: "success" | "failure";
  correlationId: string;
  resourceType?: string;
  resourceId?: string;
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  return writeJson<T>(path, "POST", body);
}

export async function putJson<T>(path: string, body?: unknown): Promise<T> {
  return writeJson<T>(path, "PUT", body);
}

export async function deleteJson<T>(path: string): Promise<T> {
  return writeJson<T>(path, "DELETE");
}

async function writeJson<T>(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<T> {
  const init: RequestInit = {
    method
  };

  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }

  const response = await fetch(path, {
    ...init
  });

  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}
