import type {
  AccessGroup,
  AccessUser,
  ModelAccessPolicy,
  ModelAccessStore,
  UpdateModelAccessPolicyInput
} from "@modeldock/core";
import type {
  ChatChunk,
  ChatInput,
  Clock,
  ComponentHealth,
  InferenceProbe,
  Model,
  ModelPullProgress,
  ModelRuntimeInput,
  OllamaGateway,
  OpenAiForwardInput,
  OpenAiForwardResponse,
  PullModelInput,
  RunningModel
} from "@modeldock/core";
import { createComponentHealth, ModelDockError, setModelEnabled, setModelLoaded } from "@modeldock/core";
import { SequentialIdGenerator } from "@modeldock/observability";
import { InMemoryAuditStore } from "@modeldock/storage";

function jsonResponse(status: number, payload: unknown): OpenAiForwardResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    status,
    contentType: "application/json",
    body: (async function* () {
      yield bytes;
    })()
  };
}

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

  /** Models listed here behave like embedding models: they cannot chat. */
  public embeddingModels = new Set<string>();

  public async getModelCapabilities(name: string): Promise<string[]> {
    return this.embeddingModels.has(name) ? ["embedding"] : ["completion"];
  }

  /** How long the fake waits between words. Raise it in tests that need time to press stop. */
  public chatDelayMs = 0;
  /** Models listed here reason before answering, like gpt-oss: a few "thinking" chunks first. */
  public thinkingModels = new Set<string>();
  /** What loading a model that is not in memory "costs", reported like Ollama does. */
  public loadMs = 1500;
  /** How long warmModel takes, for tests that look at the "loading" state. */
  public warmDelayMs = 0;
  public warmedModels: string[] = [];

  public async warmModel(name: string): Promise<{ loadMs: number }> {
    this.warmedModels.push(name);
    if (this.warmDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.warmDelayMs));
    const wasLoaded = this.models.get(name)?.running === true;
    this.updateRuntimeState(name, true);
    return { loadMs: wasLoaded ? 0 : this.loadMs };
  }

  /** The last conversation sent to the model, for tests to inspect what it received. */
  public lastChatInput: ChatInput | undefined;

  public async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
    this.lastChatInput = input;
    const question = input.messages.at(-1)?.content ?? "";
    const words = `Fake reply from ${input.model} to: ${question}`.split(" ");
    // Like Ollama: answering loads the model, and the last chunk says how long that took.
    const wasLoaded = this.models.get(input.model)?.running === true;
    if (this.models.has(input.model)) this.updateRuntimeState(input.model, true);

    if (this.thinkingModels.has(input.model)) {
      for (let step = 0; step < 3; step += 1) {
        if (input.signal?.aborted) return;
        if (this.chatDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.chatDelayMs));
        yield { content: "", done: false, thinking: true };
      }
    }

    for (const [index, word] of words.entries()) {
      if (input.signal?.aborted) {
        return;
      }

      if (this.chatDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.chatDelayMs));
      }

      yield { content: index === 0 ? word : ` ${word}`, done: false };
    }

    yield { content: "", done: true, ...(wasLoaded ? {} : { loadMs: this.loadMs }) };
  }

  /** The last request forwarded to the OpenAI-compatible endpoints, for tests to inspect. */
  public lastOpenAiRequest: OpenAiForwardInput | undefined;

  /**
   * Answers like Ollama's OpenAI-compatible layer: a chat completion (JSON, or server-sent
   * events with `stream: true`) or embeddings. An unknown model gets Ollama's 404.
   */
  public async openAi(input: OpenAiForwardInput): Promise<OpenAiForwardResponse> {
    this.lastOpenAiRequest = input;
    const model = String(input.body.model ?? "");
    if (!this.models.has(model)) {
      return jsonResponse(404, { error: { message: `model "${model}" not found, try pulling it first`, type: "api_error", param: null, code: null } });
    }

    if (input.endpoint === "/v1/embeddings") {
      const inputs = Array.isArray(input.body.input) ? input.body.input.map(String) : [String(input.body.input ?? "")];
      return jsonResponse(200, {
        object: "list",
        data: inputs.map((text, index) => ({ object: "embedding", index, embedding: [text.length, 0.5, -0.5, 1] })),
        model,
        usage: { prompt_tokens: inputs.length * 3, total_tokens: inputs.length * 3 }
      });
    }

    const messages = Array.isArray(input.body.messages) ? (input.body.messages as Array<{ content?: unknown }>) : [];
    const words = `Fake reply from ${model} to: ${String(messages.at(-1)?.content ?? "")}`.split(" ");
    const usage = { prompt_tokens: 5, completion_tokens: words.length, total_tokens: 5 + words.length };
    const base = { id: "chatcmpl-fake", created: 1_788_000_000, model, system_fingerprint: "fp_ollama" };

    if (input.body.stream !== true) {
      return jsonResponse(200, {
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: words.join(" ") }, finish_reason: "stop" }],
        usage
      });
    }

    const includeUsage = (input.body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true;
    const signal = input.signal;
    const delay = this.chatDelayMs;
    const encoder = new TextEncoder();
    async function* events(): AsyncIterable<Uint8Array> {
      const event = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
      for (const [index, word] of words.entries()) {
        if (signal?.aborted) return;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        yield event({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: index === 0 ? word : ` ${word}` }, finish_reason: null }] });
      }
      yield event({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }] });
      if (includeUsage) yield event({ ...base, object: "chat.completion.chunk", choices: [], usage });
      yield encoder.encode("data: [DONE]\n\n");
    }
    return { status: 200, contentType: "text/event-stream", body: events() };
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

  public async setUserGrant(modelName: string, userId: string, canUse: boolean): Promise<ModelAccessPolicy> {
    const current = await this.ensurePolicy(modelName);
    const grants = current.grants.filter((grant) => grant.subject.type !== "user" || grant.subject.id !== userId);
    const next = { ...current, grants: canUse ? [...grants, { subject: { type: "user" as const, id: userId }, canUse: true }] : grants };
    this.policies.set(modelName, next);
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
    ollama: new FakeOllamaGateway()
  };
}
