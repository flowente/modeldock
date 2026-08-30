export type HealthState = "available" | "degraded" | "unavailable" | "unknown" | "not_configured";
export type OverallHealth = "ok" | "degraded" | "fail";
export type DiagnosticStatus = "pass" | "warn" | "fail" | "skipped";
export type AuditResult = "success" | "failure";
export type Role = "admin" | "operator" | "viewer";
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

export interface UpdateTailnetDeviceInput {
  deviceId: string;
  authorized: boolean;
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
}

export interface TailscaleGateway {
  getLocalStatus(): Promise<ComponentHealth>;
  listDevices(): Promise<TailnetDevice[]>;
  updateDeviceAuthorization(input: UpdateTailnetDeviceInput): Promise<TailnetDevice>;
}

export interface ModelDockErrorShape {
  code: string;
  message: string;
  module: string;
  suggestion?: string;
  cause?: unknown;
}

export class ModelDockError extends Error {
  public readonly code: string;
  public readonly module: string;
  public readonly suggestion?: string;
  public override readonly cause?: unknown;

  public constructor(shape: ModelDockErrorShape) {
    super(shape.message);
    this.name = "ModelDockError";
    this.code = shape.code;
    this.module = shape.module;
    this.suggestion = shape.suggestion;
    this.cause = shape.cause;
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
