export type HealthState = "available" | "degraded" | "unavailable" | "unknown" | "not_configured";
export type OverallHealth = "ok" | "degraded" | "fail";
export type DiagnosticStatus = "pass" | "warn" | "fail" | "skipped";
export type AuditResult = "success" | "failure";
/**
 * admin: everything, including accounts. operator: runs the server, no accounts.
 * viewer: reads the dashboard. member: only chats with the models it is granted.
 */
export type Role = "admin" | "operator" | "viewer" | "member";
export type AccessSubjectType = "user" | "group";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  createId(prefix: string): string;
}

export interface ComponentHealth {
  name: string;
  status: HealthState;
  message: string;
  checkedAt: string;
  details?: Record<string, unknown>;
}

export interface SystemStatus {
  overall: OverallHealth;
  checkedAt: string;
  components: {
    backend: ComponentHealth;
    storage: ComponentHealth;
    ollama: ComponentHealth;
    /** The connection that lets other devices reach this server (modeldock-link). */
    link: ComponentHealth;
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
  cpu: {
    model: string;
    cores: number;
  };
  /* Only what is measured. No estimated speeds: a number nobody measured is not shown. */
}

export type AiServerPowerState = "on" | "off" | "starting" | "stopping" | "degraded";

export interface AiServerPowerStatus {
  state: AiServerPowerState;
  ollamaReady: boolean;
  loadedModels: number;
  message: string;
  updatedAt: string;
}

export interface OllamaSetupStatus {
  health: ComponentHealth;
  modelsPath: string;
  pathSource: "modeldock_env" | "ollama_env" | "default";
  pathExists: boolean;
  modelCount: number;
  apiBaseUrl: string;
  apiExposesModelsPath: false;
  message: string;
}

export interface Model {
  name: string;
  tag: string;
  sizeBytes: number;
  modifiedAt?: string;
  running: boolean;
}

export interface AccessSubject {
  type: AccessSubjectType;
  id: string;
}

export interface UserAccessContext {
  userId: string;
  role: Role;
  groupIds: string[];
}

export interface AccessGroup {
  id: string;
  name: string;
  description?: string;
}

export interface AccessUser {
  id: string;
  displayName: string;
  role: Role;
  groupIds: string[];
}

export interface ModelAccessGrant {
  subject: AccessSubject;
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

export interface ModelAccessStore {
  listUsers(): Promise<AccessUser[]>;
  listGroups(): Promise<AccessGroup[]>;
  listPolicies(): Promise<ModelAccessPolicy[]>;
  ensurePolicy(modelName: string): Promise<ModelAccessPolicy>;
  deletePolicy(modelName: string): Promise<void>;
  updatePolicy(input: UpdateModelAccessPolicyInput): Promise<ModelAccessPolicy>;
  /** Grants or revokes a model for one account, on top of its groups. */
  setUserGrant(modelName: string, userId: string, canUse: boolean): Promise<ModelAccessPolicy>;
}

export type AccountStatus = "active" | "invited" | "disabled";

export interface Account {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: AccountStatus;
  groupIds: string[];
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

/** An account as stored. The hash never leaves the server. */
export interface StoredAccount extends Account {
  passwordHash?: string;
}

export interface AccountPatch {
  displayName?: string;
  role?: Role;
  status?: AccountStatus;
  passwordHash?: string;
  lastLoginAt?: string;
  groupIds?: string[];
  updatedAt: string;
}

export interface StoredGroup extends AccessGroup {
  createdAt: string;
}

/** A login session. Only the SHA-256 of the token is stored. */
export interface StoredSession {
  idHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent?: string;
}

/** An invitation to create an account. Only the SHA-256 of the token is stored. */
export interface StoredInvitation {
  id: string;
  tokenHash: string;
  email: string;
  displayName: string;
  role: Role;
  groupIds: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

export interface AccountStore {
  countAccounts(): Promise<number>;
  listAccounts(): Promise<StoredAccount[]>;
  findAccountById(id: string): Promise<StoredAccount | undefined>;
  findAccountByEmail(email: string): Promise<StoredAccount | undefined>;
  insertAccount(account: StoredAccount): Promise<void>;
  updateAccount(id: string, patch: AccountPatch): Promise<void>;
  deleteAccount(id: string): Promise<void>;

  listGroups(): Promise<StoredGroup[]>;
  findGroupById(id: string): Promise<StoredGroup | undefined>;
  insertGroup(group: StoredGroup): Promise<void>;
  updateGroup(id: string, patch: { name?: string; description?: string | null }): Promise<void>;
  deleteGroup(id: string): Promise<void>;

  insertSession(session: StoredSession): Promise<void>;
  findSession(idHash: string): Promise<StoredSession | undefined>;
  touchSession(idHash: string, lastSeenAt: string, expiresAt: string): Promise<void>;
  deleteSession(idHash: string): Promise<void>;
  deleteSessionsForUser(userId: string, exceptIdHash?: string): Promise<void>;
  deleteExpiredSessions(now: string): Promise<void>;

  insertInvitation(invitation: StoredInvitation): Promise<void>;
  listInvitations(): Promise<StoredInvitation[]>;
  findInvitationByTokenHash(tokenHash: string): Promise<StoredInvitation | undefined>;
  /** Marks the invitation used. False if it was already used: two people cannot redeem one link. */
  consumeInvitation(id: string, usedAt: string): Promise<boolean>;
  deleteInvitation(id: string): Promise<void>;
}

/**
 * A key for the OpenAI-compatible API. Only the SHA-256 of the key is stored; `hint` is the
 * few characters shown in the list so its owner can tell keys apart.
 * A revoked key stays, so that its usage history keeps pointing at something.
 */
export interface StoredApiKey {
  id: string;
  userId: string;
  name: string;
  keyHash: string;
  hint: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface ApiKeyStore {
  insertApiKey(key: StoredApiKey): Promise<void>;
  /** Newest first. Without `userId`, every account's keys. Revoked keys are left out. */
  listApiKeys(userId?: string): Promise<StoredApiKey[]>;
  findApiKeyById(id: string): Promise<StoredApiKey | undefined>;
  findApiKeyByHash(keyHash: string): Promise<StoredApiKey | undefined>;
  touchApiKey(id: string, lastUsedAt: string): Promise<void>;
  revokeApiKey(id: string, revokedAt: string): Promise<void>;
}

/**
 * One call to the OpenAI-compatible API: numbers only. What was asked and answered is never kept.
 * Status 499 means the caller hung up before the answer was complete.
 */
export interface ApiUsageEntry {
  keyId: string;
  model: string;
  endpoint: "chat" | "embeddings";
  status: number;
  streamed: boolean;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  createdAt: string;
}

export interface ApiUsageTotals {
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ApiUsageDay extends ApiUsageTotals {
  /** YYYY-MM-DD in the viewer's time zone. */
  day: string;
}

export interface ApiUsageByModel extends ApiUsageTotals {
  model: string;
}

export interface ApiUsageStore {
  record(entry: ApiUsageEntry): Promise<void>;
  /** Totals per key since `since`, for the keys list. */
  totalsByKey(keyIds: string[], since: string): Promise<Map<string, ApiUsageTotals>>;
  /** Day by day since `since`. `offsetMinutes` moves UTC to the viewer's clock (Italy in summer: 120). */
  daily(keyId: string, since: string, offsetMinutes: number): Promise<ApiUsageDay[]>;
  byModel(keyId: string, since: string): Promise<ApiUsageByModel[]>;
  /** Most recent first. */
  recent(keyId: string, limit: number): Promise<ApiUsageEntry[]>;
  deleteOlderThan(before: string): Promise<void>;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

export interface ChatInput {
  model: string;
  messages: ChatTurn[];
  signal?: AbortSignal;
}

export interface ChatChunk {
  content: string;
  done: boolean;
  /** The model is reasoning before it answers: text arrives, but not for the reply. */
  thinking?: boolean;
  /** On the last chunk: how long loading the model into memory took, when it had to. */
  loadMs?: number;
}

export type ChatMessageStatus = "complete" | "stopped" | "error";

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
  status: ChatMessageStatus;
  createdAt: string;
}

export interface ChatStore {
  /** Most recent first. `query` matches titles and message text. */
  listConversations(userId: string, query?: string): Promise<Conversation[]>;
  findConversation(id: string): Promise<Conversation | undefined>;
  insertConversation(conversation: Conversation): Promise<void>;
  updateConversation(id: string, patch: { title?: string; model?: string; updatedAt: string }): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  listMessages(conversationId: string): Promise<ChatMessage[]>;
  insertMessage(message: ChatMessage): Promise<void>;
}

export interface RunningModel {
  name: string;
  sizeBytes?: number;
  expiresAt?: string;
}

export interface ModelPullProgress {
  model: string;
  status: string;
  completedBytes?: number;
  totalBytes?: number;
}

export type ModelPullJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface ModelPullJob {
  id: string;
  model: string;
  status: ModelPullJobStatus;
  message: string;
  completedBytes?: number;
  totalBytes?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullModelInput {
  name: string;
}

export interface ProbeModelInput {
  model: string;
  prompt: string;
}

export interface ModelRuntimeInput {
  model: string;
}

export interface InferenceProbe {
  model: string;
  output: string;
  durationMs: number;
  tokenCount?: number;
}

export interface DiagnosticCheckResult {
  id: string;
  label: string;
  status: DiagnosticStatus;
  message: string;
  durationMs: number;
  timestamp: string;
  details?: Record<string, unknown>;
  suggestion?: string | null;
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  run(): Promise<DiagnosticCheckResult>;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actorId: string;
  action: string;
  module: string;
  result: AuditResult;
  correlationId: string;
  resourceType?: string;
  resourceId?: string;
  errorCode?: string;
}

export interface AuditEventInput {
  actorId: string;
  action: string;
  module: string;
  result: AuditResult;
  correlationId: string;
  resourceType?: string;
  resourceId?: string;
  errorCode?: string;
}

export interface AuditStore {
  append(event: AuditEventInput): Promise<AuditEvent>;
  list(limit?: number): Promise<AuditEvent[]>;
}

export interface OllamaGateway {
  getHealth(): Promise<ComponentHealth>;
  listLocalModels(): Promise<Model[]>;
  listRunningModels(): Promise<RunningModel[]>;
  loadModel(input: ModelRuntimeInput): Promise<void>;
  unloadModel(input: ModelRuntimeInput): Promise<void>;
  pullModel(input: PullModelInput): AsyncIterable<ModelPullProgress>;
  deleteModel(name: string): Promise<void>;
  probeModel(input: ProbeModelInput): Promise<InferenceProbe>;
  /** Streams a chat reply piece by piece. Aborting `signal` stops the model. */
  chat(input: ChatInput): AsyncIterable<ChatChunk>;
  /**
   * What a model can do, as Ollama reports it ("completion", "embedding", "tools"...).
   * Empty when Ollama is too old to say.
   */
  getModelCapabilities(name: string): Promise<string[]>;
  /**
   * Forwards a request to Ollama's OpenAI-compatible endpoints and hands back its answer as it
   * comes, streaming included. ModelDock checks the key and the model before calling this.
   */
  openAi(input: OpenAiForwardInput): Promise<OpenAiForwardResponse>;
  /** Loads a model into memory ahead of the first message. Resolves once it is ready. */
  warmModel(name: string): Promise<{ loadMs: number }>;
}

export type OpenAiEndpoint = "/v1/chat/completions" | "/v1/embeddings";

export interface OpenAiForwardInput {
  endpoint: OpenAiEndpoint;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface OpenAiForwardResponse {
  status: number;
  contentType: string;
  body: AsyncIterable<Uint8Array>;
}

export interface ModelDockErrorShape {
  code: string;
  message: string;
  module: string;
  suggestion?: string;
  cause?: unknown;
  /** HTTP status the API answers with. Defaults to 400. */
  httpStatus?: number;
}

export class ModelDockError extends Error {
  public readonly code: string;
  public readonly module: string;
  public readonly suggestion?: string;
  public override readonly cause?: unknown;
  public readonly httpStatus: number;

  public constructor(shape: ModelDockErrorShape) {
    super(shape.message);
    this.name = "ModelDockError";
    this.code = shape.code;
    this.module = shape.module;
    this.suggestion = shape.suggestion;
    this.cause = shape.cause;
    this.httpStatus = shape.httpStatus ?? 400;
  }
}

export function evaluateOverall(components: ComponentHealth[]): OverallHealth {
  if (components.some((component) => component.status === "unavailable")) {
    return "fail";
  }

  if (components.some((component) => ["degraded", "unknown", "not_configured"].includes(component.status))) {
    return "degraded";
  }

  return "ok";
}

export function collectWarnings(components: ComponentHealth[]): string[] {
  return components
    .filter((component) => component.status !== "available")
    .map((component) => `${component.name}: ${component.message}`);
}

export function createComponentHealth(input: Omit<ComponentHealth, "checkedAt">, clock: Clock): ComponentHealth {
  return {
    ...input,
    checkedAt: clock.now().toISOString()
  };
}

export interface BuildSystemStatusInput {
  backend: ComponentHealth;
  storage: ComponentHealth;
  ollama: ComponentHealth;
  link: ComponentHealth;
  checkedAt: string;
}

export function buildSystemStatus(input: BuildSystemStatusInput): SystemStatus {
  // A connection switched off on purpose ("not_configured") does not make the server unhealthy.
  const required = [input.backend, input.storage, input.ollama];
  const healthComponents = input.link.status === "not_configured" ? required : [...required, input.link];

  return {
    overall: evaluateOverall(healthComponents),
    checkedAt: input.checkedAt,
    components: {
      backend: input.backend,
      storage: input.storage,
      ollama: input.ollama,
      link: input.link
    },
    warnings: collectWarnings(healthComponents)
  };
}

export function canUseModel(policy: ModelAccessPolicy, user: UserAccessContext): boolean {
  if (!policy.enabled) {
    return false;
  }

  // Administrators always reach every enabled model: a grant can never lock them out.
  if (user.role === "admin") {
    return true;
  }

  return policy.grants.some((grant) => grant.canUse && matchesSubject(grant.subject, user));
}

export function listAllowedModels(policies: ModelAccessPolicy[], user: UserAccessContext): ModelAccessPolicy[] {
  return policies.filter((policy) => canUseModel(policy, user));
}

export function setModelEnabled(policy: ModelAccessPolicy, enabled: boolean): ModelAccessPolicy {
  return {
    ...policy,
    enabled
  };
}

export function setModelLoaded(policy: ModelAccessPolicy, loaded: boolean): ModelAccessPolicy {
  return {
    ...policy,
    loaded
  };
}

function matchesSubject(subject: AccessSubject, user: UserAccessContext): boolean {
  if (subject.type === "user") {
    return subject.id === user.userId;
  }

  return user.groupIds.includes(subject.id);
}
