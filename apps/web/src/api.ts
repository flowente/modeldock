export type {
  AccessGroup,
  AccessUser,
  AiServerPowerStatus,
  AuditEvent,
  ComponentHealth,
  DiagnosticCheck,
  DiagnosticCheckResult,
  Model,
  ModelAccessGrant,
  ModelAccessMatrix,
  ModelAccessPolicy,
  ModelPullJob,
  ModelPullProgress,
  ManagedServerSetupStatus,
  OllamaSetupStatus,
  OpenWebUIRuntimeStatus,
  OpenWebUISetupStatus,
  SystemResources,
  SystemStatus,
  TailnetChatExposure,
  TailnetDevice,
  TailnetUserInvite,
  TailscaleApiConnectionStatus,
  TailscaleSetupStatus,
  UpdateModelAccessPolicyInput
} from "../../../packages/core/src/index.js";

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
