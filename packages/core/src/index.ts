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

export type AiServerPowerState = "on" | "off" | "starting" | "stopping" | "degraded";

export interface AiServerPowerStatus {
  state: AiServerPowerState;
  ollamaReady: boolean;
  chatReady: boolean;
  managedChat: boolean;
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

export type ManagedServerSetupState = "idle" | "running" | "succeeded" | "failed";
export type ManagedServerSetupPhase =
  | "idle"
  | "checking"
  | "installing_ollama"
  | "starting_ollama"
  | "installing_chat"
  | "starting_chat"
  | "configuring_admin"
  | "ready"
  | "failed";

export interface ManagedServerSetupStatus {
  state: ManagedServerSetupState;
  phase: ManagedServerSetupPhase;
  progress: number;
  message: string;
  ollamaReady: boolean;
  chatReady: boolean;
  adminReady: boolean;
  chatUrl?: string;
  startedAt?: string;
  updatedAt: string;
}

/**
 * How the local chat is published to the tailnet.
 *
 * Open WebUI binds to loopback only. `tailscale serve` is what makes it
 * reachable from other devices in the tailnet - and nothing else. Without it
 * the chat is local to the server machine, so `active: false` is a real
 * failure of the remote path, not a cosmetic detail.
 */
export type TailnetChatExposureMode = "https" | "http" | "none";

export interface TailnetChatExposure {
  active: boolean;
  mode: TailnetChatExposureMode;
  /** Shareable tailnet URL, present only when active. */
  url?: string;
  /** Local port being proxied (Open WebUI). */
  port: number;
  message: string;
}

export interface TailscaleSetupStatus {
  health: ComponentHealth;
  installed: boolean;
  loggedIn: boolean;
  backendState?: string;
  tailnet?: string;
  hostname?: string;
  addresses: string[];
  suggestedServerUrl?: string;
  apiRequiredForDeviceWrites: boolean;
  message: string;
}

export interface TailscaleApiConnectionStatus {
  configured: boolean;
  connected: boolean;
  message: string;
}

export interface OpenWebUISetupStatus {
  health: ComponentHealth;
  baseUrl?: string;
  reachable: boolean;
  apiKeyConfigured: boolean;
  adminVerified: boolean;
  authenticatedUser?: {
    id?: string;
    name?: string;
    email?: string;
    role?: string;
  };
  modelCount?: number;
  message: string;
}

export type OpenWebUIRuntimeState = "running" | "starting" | "not_running" | "tool_missing";

export interface OpenWebUIRuntimeStatus {
  health: ComponentHealth;
  baseUrl: string;
  dataDir: string;
  executablePath?: string;
  installPath?: string;
  installed: boolean;
  managedRuntimeAvailable: boolean;
  port: number;
  uvAvailable: boolean;
  running: boolean;
  startedByModelDock: boolean;
  state: OpenWebUIRuntimeState;
  log: string[];
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

export interface TailnetDevice {
  id: string;
  hostname: string;
  addresses: string[];
  online: boolean | "unknown";
  authorized: boolean;
  os?: string;
  lastSeen?: string;
}

export interface CreateTailnetUserInviteInput {
  email?: string;
  role?: "member";
}

export interface TailnetUserInvite {
  id: string;
  inviteUrl: string;
  role: "member";
  email?: string;
  expiresAt?: string;
}

export interface UpdateTailnetDeviceInput {
  deviceId: string;
  authorized: boolean;
}

export interface CreateTailnetAuthKeyInput {
  /** Allow the key to enrol more than one device. Prefer false for single-use invites. */
  reusable?: boolean;
  /** Ephemeral devices are removed automatically when they go offline. */
  ephemeral?: boolean;
  /** Pre-authorize devices so they join without manual approval in the admin console. */
  preauthorized?: boolean;
  /** ACL tags that own the joined device (e.g. ["tag:modeldock-client"]). */
  tags?: string[];
  /** Key lifetime in seconds before it can no longer enrol devices. */
  expirySeconds?: number;
  /** Human-readable label shown in the Tailscale admin console. */
  description?: string;
}

export interface TailnetAuthKey {
  id: string;
  /** The secret `tskey-...` value. Handle as a credential: never log or persist it. */
  key: string;
  reusable: boolean;
  ephemeral: boolean;
  tags: string[];
  expiresAt?: string;
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
}

export interface TailscaleGateway {
  getLocalStatus(): Promise<ComponentHealth>;
  listDevices(): Promise<TailnetDevice[]>;
  createUserInvite(input: CreateTailnetUserInviteInput): Promise<TailnetUserInvite>;
  updateDeviceAuthorization(input: UpdateTailnetDeviceInput): Promise<TailnetDevice>;
  createAuthKey(input: CreateTailnetAuthKeyInput): Promise<TailnetAuthKey>;
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
  tailscale: ComponentHealth;
  openWebUI: ComponentHealth;
  checkedAt: string;
}

export function buildSystemStatus(input: BuildSystemStatusInput): SystemStatus {
  const requiredComponents = [input.backend, input.storage, input.ollama, input.tailscale];
  const healthComponents = input.openWebUI.status === "not_configured" ? requiredComponents : [...requiredComponents, input.openWebUI];

  return {
    overall: evaluateOverall(healthComponents),
    checkedAt: input.checkedAt,
    components: {
      backend: input.backend,
      storage: input.storage,
      ollama: input.ollama,
      tailscale: input.tailscale,
      openWebUI: input.openWebUI
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
