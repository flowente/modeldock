import type {
  Account,
  AiServerPowerStatus,
  AuditEvent,
  ChatMessage,
  ComponentHealth,
  DiagnosticCheckResult,
  OllamaSetupStatus,
  RunningModel,
  SystemResources,
  SystemStatus,
  Conversation,
  Model,
  ModelAccessMatrix,
  ModelAccessPolicy,
  ModelPullJob,
  Role,
  StoredGroup
} from "../../../../packages/core/src/index.ts";

export type {
  Account,
  AiServerPowerStatus,
  AuditEvent,
  ChatMessage,
  ComponentHealth,
  Conversation,
  DiagnosticCheckResult,
  Model,
  ModelAccessMatrix,
  ModelAccessPolicy,
  ModelPullJob,
  OllamaSetupStatus,
  Role,
  RunningModel,
  StoredGroup,
  SystemResources,
  SystemStatus
};

export interface LinkedDevice {
  id: string;
  hostname: string;
  os?: string;
  authorized: boolean;
  online: boolean;
  createdAt: string;
  lastSeen?: string;
}

export interface DeviceInvite {
  id: string;
  expiresAt: string;
  reusable: boolean;
  requiresPin: boolean;
  uses: number;
}

export interface DevicesOverview {
  connection: { port: number; hosts: Array<{ host: string; port: number }>; fingerprint: string; allowUnpairedBrowsers: boolean };
  devices: LinkedDevice[];
  invites: DeviceInvite[];
}

export interface InvitationSummary {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  groupIds: string[];
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

export interface ApiUsageTotals {
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ApiUsageDay extends ApiUsageTotals {
  day: string;
}

export interface ApiUsageEntry {
  model: string;
  endpoint: "chat" | "embeddings";
  status: number;
  streamed: boolean;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  createdAt: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt?: string;
  owner: { id: string; displayName: string; email: string };
  /** The last 30 days. */
  usage: ApiUsageTotals;
}

export interface ApiKeyUsage {
  key: Omit<ApiKeySummary, "usage">;
  period: { days: number; since: string };
  totals: ApiUsageTotals;
  daily: ApiUsageDay[];
  byModel: Array<ApiUsageTotals & { model: string }>;
  recent: ApiUsageEntry[];
}

export interface AuthState {
  setupRequired: boolean;
  requireLogin: boolean;
  account: Account | null;
}

export interface ChatModel {
  name: string;
  sizeBytes: number;
  /** As Ollama reports them: "completion", "tools", "thinking", "vision"... */
  capabilities: string[];
}

export type StreamEvent =
  | { type: "conversation"; conversation: Conversation }
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; content: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; error: { code: string; message: string }; message?: ChatMessage };

/** An API error with the server's code, so screens can say something specific. */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    throw new ApiError(response.status, body.error?.code ?? "HTTP_ERROR", body.error?.message ?? `HTTP ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  state: () => request<AuthState>("/api/auth/state"),
  setup: (body: { email: string; displayName: string; password: string }) => request<{ account: Account }>("/api/auth/setup", json(body)),
  login: (body: { email: string; password: string }) => request<{ account: Account }>("/api/auth/login", json(body)),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  previewInvitation: (token: string) =>
    request<{ email: string; displayName: string; expiresAt: string }>(`/api/auth/invitations/${encodeURIComponent(token)}`),
  acceptInvitation: (token: string, password: string) =>
    request<{ account: Account }>(`/api/auth/invitations/${encodeURIComponent(token)}/accept`, json({ password })),

  models: () => request<ChatModel[]>("/api/chat/models"),
  conversations: (query?: string) =>
    request<Conversation[]>(`/api/chat/conversations${query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`),
  conversation: (id: string) => request<{ conversation: Conversation; messages: ChatMessage[] }>(`/api/chat/conversations/${encodeURIComponent(id)}`),
  rename: (id: string, title: string) =>
    request<Conversation>(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  remove: (id: string) => request<void>(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // ---- Own account ----
  renameMe: (displayName: string) => request<Account>("/api/auth/me", { method: "PATCH", body: JSON.stringify({ displayName }) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("/api/auth/password", json({ currentPassword, newPassword })),

  // ---- API keys ----
  apiKeys: (scope: "own" | "all") => request<ApiKeySummary[]>(`/api/api-keys${scope === "all" ? "?scope=all" : ""}`),
  createApiKey: (name: string) => request<{ key: ApiKeySummary; secret: string }>("/api/api-keys", json({ name })),
  apiKeyUsage: (id: string, days: number, offset: number) =>
    request<ApiKeyUsage>(`/api/api-keys/${encodeURIComponent(id)}/usage?days=${days}&offset=${offset}`),
  revokeApiKey: (id: string) => request<void>(`/api/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // ---- Administration ----
  users: () => request<Account[]>("/api/users"),
  updateUser: (id: string, patch: { displayName?: string; role?: Role; status?: "active" | "disabled"; groupIds?: string[] }) =>
    request<Account>(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteUser: (id: string) => request<void>(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }),

  groups: () => request<StoredGroup[]>("/api/groups"),
  createGroup: (name: string) => request<StoredGroup>("/api/groups", json({ name })),
  renameGroup: (id: string, name: string) => request<StoredGroup>(`/api/groups/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteGroup: (id: string) => request<void>(`/api/groups/${encodeURIComponent(id)}`, { method: "DELETE" }),

  invitations: () => request<InvitationSummary[]>("/api/invitations"),
  invite: (body: { email: string; displayName: string; role: Role; groupIds: string[] }) =>
    request<{ invitation: InvitationSummary; token: string; acceptPath: string }>("/api/invitations", json(body)),
  revokeInvitation: (id: string) => request<void>(`/api/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),

  installedModels: () => request<Model[]>("/api/models"),
  modelCapabilities: () => request<Record<string, { chat: boolean }>>("/api/chat/model-capabilities"),
  accessMatrix: () => request<ModelAccessMatrix>("/api/access/model-policies"),
  updatePolicy: (modelName: string, patch: { enabled?: boolean; groupGrants?: Record<string, boolean> }) =>
    request<ModelAccessPolicy>("/api/access/model-policies", { method: "PUT", body: JSON.stringify({ modelName, ...patch }) }),
  setUserGrant: (modelName: string, userId: string, canUse: boolean) =>
    request<ModelAccessPolicy>(`/api/access/model-policies/${encodeURIComponent(modelName)}/users/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify({ canUse })
    }),
  pullModel: (name: string) => request<ModelPullJob>("/api/models/pull", json({ name })),
  pullJob: (id: string) => request<ModelPullJob>(`/api/models/pull-jobs/${encodeURIComponent(id)}`),
  deleteModel: (name: string) => request<unknown>(`/api/models/${encodeURIComponent(name)}`, { method: "DELETE" }),

  // ---- Server ----
  systemStatus: () => request<SystemStatus>("/api/system/status"),
  resources: () => request<SystemResources>("/api/system/resources"),
  ollamaInfo: () => request<OllamaSetupStatus>("/api/system/ollama"),
  power: () => request<AiServerPowerStatus>("/api/server/power"),
  startOllama: () => request<AiServerPowerStatus>("/api/server/power/start", { method: "POST" }),
  releaseMemory: () => request<AiServerPowerStatus>("/api/server/release-memory", { method: "POST" }),
  runningModels: () => request<RunningModel[]>("/api/models/running"),
  unloadModel: (name: string) => request<unknown>(`/api/models/${encodeURIComponent(name)}/unload`, { method: "POST" }),
  runDiagnostics: () => request<DiagnosticCheckResult[]>("/api/diagnostics/run-all", { method: "POST" }),
  auditEvents: () => request<AuditEvent[]>("/api/audit/events"),

  // ---- Devices ----
  devices: () => request<DevicesOverview>("/api/devices"),
  inviteDevice: (body: { requirePin: boolean; reusable?: boolean; hours?: number }) =>
    request<{ invite: DeviceInvite; link: string; pin?: string }>("/api/devices/invites", json(body)),
  revokeDeviceInvite: (id: string) => request<void>(`/api/devices/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setDeviceAuthorized: (id: string, authorized: boolean) =>
    request<LinkedDevice>(`/api/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ authorized }) }),
  removeDevice: (id: string) => request<void>(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" })
};

/**
 * Sends a message and calls `onEvent` for every piece of the reply as it arrives.
 * Aborting `signal` is the stop button: the server keeps what was written so far.
 */
export async function streamMessage(
  body: { conversationId?: string; model: string; content: string },
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const response = await fetch("/api/chat/messages", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok || !response.body) {
    const error = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    throw new ApiError(response.status, error.error?.code ?? "HTTP_ERROR", error.error?.message ?? `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as StreamEvent);
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as StreamEvent);
}
