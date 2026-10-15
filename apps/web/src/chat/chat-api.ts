import type {
  Account,
  ChatMessage,
  Conversation,
  Model,
  ModelAccessMatrix,
  ModelAccessPolicy,
  ModelPullJob,
  Role,
  StoredGroup
} from "../../../../packages/core/src/index.ts";

export type { Account, ChatMessage, Conversation, Model, ModelAccessMatrix, ModelAccessPolicy, ModelPullJob, Role, StoredGroup };

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

export interface AuthState {
  setupRequired: boolean;
  requireLogin: boolean;
  account: Account | null;
}

export interface ChatModel {
  name: string;
  sizeBytes: number;
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
  deleteModel: (name: string) => request<unknown>(`/api/models/${encodeURIComponent(name)}`, { method: "DELETE" })
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
