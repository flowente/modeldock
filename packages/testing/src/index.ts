import type {
  AccessGroup,
  AccessUser,
  ModelAccessPolicy,
  ModelAccessStore,
  UpdateModelAccessPolicyInput
} from "@modeldock/core";
import type {
  Clock,
  ComponentHealth,
  InferenceProbe,
  Model,
  ModelPullProgress,
  ModelRuntimeInput,
  OllamaGateway,
  PullModelInput,
  RunningModel,
  CreateTailnetUserInviteInput,
  TailnetDevice,
  TailnetUserInvite,
  TailscaleGateway,
  UpdateTailnetDeviceInput
} from "@modeldock/core";
import { createComponentHealth, ModelDockError, setModelEnabled, setModelLoaded } from "@modeldock/core";
import { SequentialIdGenerator } from "@modeldock/observability";
import { InMemoryAuditStore } from "@modeldock/storage";

export class FixedClock implements Clock {
  private readonly value: Date;

  public constructor(value = new Date("2026-08-29T00:00:00.000Z")) {
    this.value = value;
  }

  public now(): Date {
    return new Date(this.value);
  }
}

export class FakeOllamaGateway implements OllamaGateway {
  private readonly mode: "ok" | "offline" | "empty";
  private readonly models = new Map<string, Model>([
    [
      "llama3.1:8b",
      {
        name: "llama3.1:8b",
        tag: "8b",
        sizeBytes: 4_700_000_000,
        modifiedAt: "2026-08-28T20:00:00.000Z",
        running: true
      }
    ],
    [
      "phi3:mini",
      {
        name: "phi3:mini",
        tag: "mini",
        sizeBytes: 2_300_000_000,
        modifiedAt: "2026-08-27T18:00:00.000Z",
        running: false
      }
    ],
    [
      "llama3.3:70b",
      {
        name: "llama3.3:70b",
        tag: "70b",
        sizeBytes: 42_000_000_000,
        modifiedAt: "2026-08-26T09:00:00.000Z",
        running: false
      }
    ]
  ]);

  public constructor(mode: "ok" | "offline" | "empty" = "ok") {
    this.mode = mode;
  }

  public async getHealth(): Promise<ComponentHealth> {
    if (this.mode === "offline") {
      return createComponentHealth(
        {
          name: "ollama",
          status: "unavailable",
          message: "Ollama fake is offline",
          details: { baseUrl: "http://127.0.0.1:11434" }
        },
        new FixedClock()
      );
    }

    return createComponentHealth(
      {
        name: "ollama",
        status: "available",
        message: "Ollama fake is reachable",
        details: { version: "fake-0.1.0" }
      },
      new FixedClock()
    );
  }

  public async listLocalModels(): Promise<Model[]> {
    if (this.mode === "offline") {
      throw new ModelDockError({
        code: "DEPENDENCY_UNAVAILABLE",
        module: "ollama-adapter",
        message: "Ollama fake is offline",
        suggestion: "Start Ollama or switch ModelDock to fake mode."
      });
    }

    if (this.mode === "empty") {
      return [];
    }

    return [...this.models.values()].map((model) => cloneModel(model));
  }

  public async listRunningModels(): Promise<RunningModel[]> {
    return [...this.models.values()]
      .filter((model) => model.running)
      .map((model) => ({ name: model.name, sizeBytes: model.sizeBytes, expiresAt: "2026-08-29T00:05:00.000Z" }));
  }

  public async loadModel(input: ModelRuntimeInput): Promise<void> {
    this.updateRuntimeState(input.model, true);
  }

  public async unloadModel(input: ModelRuntimeInput): Promise<void> {
    this.updateRuntimeState(input.model, false);
  }

  public async *pullModel(input: PullModelInput): AsyncIterable<ModelPullProgress> {
    const name = input.name.trim();

    yield { model: input.name, status: "pulling manifest" };
    yield { model: input.name, status: "downloading", completedBytes: 50, totalBytes: 100 };

    this.models.set(name, {
      name,
      tag: inferModelTag(name),
      sizeBytes: inferFakeModelSizeBytes(name),
      modifiedAt: "2026-08-29T00:00:00.000Z",
      running: false
    });

    yield { model: input.name, status: "success", completedBytes: 100, totalBytes: 100 };
  }

  public async deleteModel(name: string): Promise<void> {
    if (!name.trim()) {
      throw new ModelDockError({
        code: "INVALID_INPUT",
        module: "ollama-adapter",
        message: "Model name is required"
      });
    }

    this.models.delete(name);
  }

  public async probeModel(input: { model: string; prompt: string }): Promise<InferenceProbe> {
    return {
      model: input.model,
      output: `Fake response for: ${input.prompt}`,
      durationMs: 28,
      tokenCount: 12
    };
  }

  private updateRuntimeState(modelName: string, running: boolean): void {
    const current = this.models.get(modelName);

    if (!current) {
      throw new ModelDockError({
        code: "MODEL_NOT_FOUND",
        module: "ollama-adapter",
        message: `No Ollama fake model exists with name ${modelName}`
      });
    }

    this.models.set(modelName, {
      ...current,
      running
    });
  }
}

function cloneModel(model: Model): Model {
  return { ...model };
}

function inferModelTag(name: string): string {
  const [, tag] = name.split(":");
  return tag || "latest";
}

function inferFakeModelSizeBytes(name: string): number {
  if (/70b/i.test(name)) {
    return 42_000_000_000;
  }

  if (/(13b|14b)/i.test(name)) {
    return 8_000_000_000;
  }

  if (/(7b|8b)/i.test(name)) {
    return 4_700_000_000;
  }

  if (/mini/i.test(name)) {
    return 2_300_000_000;
  }

  return 3_600_000_000;
}

export class FakeTailscaleGateway implements TailscaleGateway {
  private readonly mode: "ok" | "offline" | "empty";
  private readonly devices = new Map<string, TailnetDevice>([
    [
      "node_local",
      {
        id: "node_local",
        hostname: "modeldock-node",
        addresses: ["100.64.0.10"],
        online: true,
        authorized: true,
        os: "windows",
        lastSeen: "2026-08-29T00:00:00.000Z"
      }
    ],
    [
      "phone_1",
      {
        id: "phone_1",
        hostname: "simone-phone",
        addresses: ["100.64.0.20"],
        online: false,
        authorized: false,
        os: "ios",
        lastSeen: "2026-08-28T22:00:00.000Z"
      }
    ]
  ]);

  public constructor(mode: "ok" | "offline" | "empty" = "ok") {
    this.mode = mode;
  }

  public async getLocalStatus(): Promise<ComponentHealth> {
    if (this.mode === "offline") {
      return createComponentHealth(
        {
          name: "tailscale",
          status: "unavailable",
          message: "Tailscale fake is offline"
        },
        new FixedClock()
      );
    }

    return createComponentHealth(
      {
        name: "tailscale",
        status: "available",
        message: "Tailscale fake is connected",
        details: { tailnetIp: "100.64.0.10", hostname: "modeldock-node" }
      },
      new FixedClock()
    );
  }

  public async listDevices(): Promise<TailnetDevice[]> {
    if (this.mode === "empty") {
      return [];
    }

    return [...this.devices.values()].map((device) => cloneDevice(device));
  }

  public async createUserInvite(input: CreateTailnetUserInviteInput): Promise<TailnetUserInvite> {
    const email = input.email?.trim().toLowerCase();

    return {
      id: "invite-1",
      inviteUrl: "https://login.tailscale.com/uinv/modeldock-test",
      role: "member",
      email,
      expiresAt: "2026-10-02T00:00:00.000Z"
    };
  }

  public async updateDeviceAuthorization(input: UpdateTailnetDeviceInput): Promise<TailnetDevice> {
    const current = this.devices.get(input.deviceId);

    if (!current) {
      throw new ModelDockError({
        code: "TAILNET_DEVICE_NOT_FOUND",
        module: "tailscale-adapter",
        message: `No Tailscale device exists with id ${input.deviceId}`
      });
    }

    const next = {
      ...current,
      authorized: input.authorized
    };

    this.devices.set(input.deviceId, next);
    return cloneDevice(next);
  }
}

function cloneDevice(device: TailnetDevice): TailnetDevice {
  return {
    ...device,
    addresses: [...device.addresses]
  };
}

export class FakeModelAccessStore implements ModelAccessStore {
  private readonly users: AccessUser[] = [
    {
      id: "usr-simone",
      displayName: "Simone",
      role: "admin",
      groupIds: ["grp-admins", "grp-builders"]
    },
    {
      id: "usr-guest",
      displayName: "Guest user",
      role: "viewer",
      groupIds: ["grp-guests"]
    }
  ];

  private readonly groups: AccessGroup[] = [
    {
      id: "grp-admins",
      name: "Admins",
      description: "Full operational access"
    },
    {
      id: "grp-builders",
      name: "Builders",
      description: "Can use everyday local models"
    },
    {
      id: "grp-guests",
      name: "Guests",
      description: "Restricted demo access"
    }
  ];

  private readonly policies = new Map<string, ModelAccessPolicy>([
    [
      "llama3.1:8b",
      {
        modelName: "llama3.1:8b",
        enabled: true,
        loaded: true,
        grants: [
          { subject: { type: "group", id: "grp-admins" }, canUse: true },
          { subject: { type: "group", id: "grp-builders" }, canUse: true }
        ]
      }
    ],
    [
      "phi3:mini",
      {
        modelName: "phi3:mini",
        enabled: true,
        loaded: false,
        grants: [
          { subject: { type: "group", id: "grp-admins" }, canUse: true },
          { subject: { type: "group", id: "grp-builders" }, canUse: true },
          { subject: { type: "group", id: "grp-guests" }, canUse: true }
        ]
      }
    ],
    [
      "llama3.3:70b",
      {
        modelName: "llama3.3:70b",
        enabled: false,
        loaded: false,
        grants: [{ subject: { type: "group", id: "grp-admins" }, canUse: true }]
      }
    ]
  ]);

  public async listUsers(): Promise<AccessUser[]> {
    return this.users.map((user) => ({ ...user, groupIds: [...user.groupIds] }));
  }

  public async listGroups(): Promise<AccessGroup[]> {
    return this.groups.map((group) => ({ ...group }));
  }

  public async listPolicies(): Promise<ModelAccessPolicy[]> {
    return [...this.policies.values()].map((policy) => clonePolicy(policy));
  }

  public async ensurePolicy(modelName: string): Promise<ModelAccessPolicy> {
    const current = this.policies.get(modelName);

    if (current) {
      return clonePolicy(current);
    }

    const policy: ModelAccessPolicy = {
      modelName,
      enabled: true,
      loaded: false,
      grants: [{ subject: { type: "group", id: "grp-admins" }, canUse: true }]
    };

    this.policies.set(modelName, policy);
    return clonePolicy(policy);
  }

  public async deletePolicy(modelName: string): Promise<void> {
    this.policies.delete(modelName);
  }

  public async updatePolicy(input: UpdateModelAccessPolicyInput): Promise<ModelAccessPolicy> {
    const current = this.policies.get(input.modelName);

    if (!current) {
      throw new ModelDockError({
        code: "MODEL_ACCESS_POLICY_NOT_FOUND",
        module: "access-control",
        message: `No access policy exists for model ${input.modelName}`
      });
    }

    let next = clonePolicy(current);

    if (typeof input.enabled === "boolean") {
      next = setModelEnabled(next, input.enabled);
    }

    if (typeof input.loaded === "boolean") {
      next = setModelLoaded(next, input.loaded);
    }

    if (input.groupGrants) {
      next = applyGroupGrants(next, input.groupGrants);
    }

    this.policies.set(input.modelName, next);
    return clonePolicy(next);
  }
}

function applyGroupGrants(policy: ModelAccessPolicy, groupGrants: Record<string, boolean>): ModelAccessPolicy {
  const changedGroupIds = new Set(Object.keys(groupGrants));
  const retainedGrants = policy.grants.filter((grant) => grant.subject.type !== "group" || !changedGroupIds.has(grant.subject.id));
  const nextGroupGrants = Object.entries(groupGrants)
    .filter(([, canUse]) => canUse)
    .map(([groupId]) => ({
      subject: { type: "group" as const, id: groupId },
      canUse: true
    }));

  return {
    ...policy,
    grants: [...retainedGrants, ...nextGroupGrants]
  };
}

function clonePolicy(policy: ModelAccessPolicy): ModelAccessPolicy {
  return {
    ...policy,
    grants: policy.grants.map((grant) => ({
      subject: { ...grant.subject },
      canUse: grant.canUse
    }))
  };
}

export function createFakeDependencies() {
  const clock = new FixedClock();
  const ids = new SequentialIdGenerator();
  const auditStore = new InMemoryAuditStore(clock, ids);

  return {
    clock,
    ids,
    auditStore,
    modelAccess: new FakeModelAccessStore(),
    ollama: new FakeOllamaGateway(),
    tailscale: new FakeTailscaleGateway()
  };
}
