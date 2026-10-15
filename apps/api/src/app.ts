import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cpus, freemem, homedir, platform, totalmem } from "node:os";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import {
  buildSystemStatus,
  createComponentHealth,
  ModelDockError,
  type AiServerPowerStatus,
  type AuditEvent,
  type Clock,
  type ComponentHealth,
  type DiagnosticCheckResult,
  type IdGenerator,
  type Model,
  type ModelAccessStore,
  type ModelPullJob,
  type OllamaGateway,
  type OllamaSetupStatus,
  type SystemResources
} from "@modeldock/core";
import { AccountService } from "@modeldock/auth";
import { createDiagnosticRegistry } from "@modeldock/diagnostics";
import { FileStateStore, LinkRegistry, listLanAddresses, loadOrCreateIdentity, startLinkServer } from "@modeldock/link";
import { OllamaHttpGateway } from "@modeldock/ollama-adapter";
import { openDatabase, SqliteAccountStore, SqliteAuditStore, SqliteChatStore, SqliteModelAccessStore } from "@modeldock/storage";
import { createFakeDependencies } from "@modeldock/testing";
import { registerAccountRoutes } from "./auth-routes.ts";
import { registerChatRoutes } from "./chat-routes.ts";
import { registerDevicesRoutes, type LinkRuntime } from "./devices-routes.ts";

export type OllamaRuntimeMode = "fake" | "real" | "auto";

export interface LinkOptions {
  /** Port other devices connect to. 0 picks a free one (tests). */
  port: number;
  /** Where the connection keeps its certificate and its devices. */
  dataDir: string;
  /** The API's own port: the connection forwards there. */
  upstreamPort: number;
  /** Lets a phone's browser on the same network in, protected only by the login. */
  allowUnpairedBrowsers: boolean;
  /** Network interface to listen on. Defaults to every interface. */
  listenHost?: string;
}

export interface BuildAppOptions {
  logger?: boolean;
  /**
   * SQLite file for accounts, permissions, conversations and the audit log. Without it the
   * data lives in a throwaway in-memory database and permissions stay on the demo data:
   * that is for tests, never for a real install.
   */
  databasePath?: string;
  /** Every API route needs a signed-in account. The server config turns it on; tests leave it off. */
  requireLogin?: boolean;
  ollamaBaseUrl?: string;
  ollamaModelsPath?: string;
  ollamaMode?: OllamaRuntimeMode;
  /** Replaces the Ollama gateway. For tests that need a model with a particular behaviour. */
  ollamaGateway?: OllamaGateway;
  /** The built web app, served at "/". Left out in tests and in development, where Vite serves it. */
  webRoot?: string;
  /** The connection between devices (modeldock-link). Left out, ModelDock runs without it. */
  link?: LinkOptions;
}

interface RuntimeDependencies {
  accounts: AccountService;
  chats: SqliteChatStore;
  storage: { persistent: boolean; location: string; close(): void };
  clock: Clock;
  ids: IdGenerator;
  auditStore: SqliteAuditStore | ReturnType<typeof createFakeDependencies>["auditStore"];
  modelAccess: ModelAccessStore;
  ollama: OllamaGateway;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const dependencies = createRuntimeDependencies(options);
  const link = options.link ? await startLink(options.link) : null;
  const diagnostics = createDiagnosticRegistry({ ...dependencies, ...(link ? { link: async () => linkHealth(link, dependencies.clock) } : {}) });
  const modelPullJobs = new Map<string, ModelPullJob>();
  let powerTransition: "starting" | null = null;

  // Requests that come through the device connection carry the device's real address in
  // X-Forwarded-For. Trust it only from the connection itself, which runs on this machine.
  const app = Fastify({ logger: options.logger ?? false, trustProxy: ["127.0.0.1", "::1"] });

  // First, before any route or plugin: routes registered earlier than the handler, or before an
  // awaited plugin, keep Fastify's default one and every ModelDockError would come out as a 500.
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ModelDockError) {
      await reply.status(error.httpStatus).send({
        error: { code: error.code, message: error.message, module: error.module, suggestion: error.suggestion, correlationId: request.id }
      });
      return;
    }

    const httpError = error as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof httpError.statusCode === "number" ? httpError.statusCode : 500;
    const message = typeof httpError.message === "string" ? httpError.message : "HTTP request error";

    if (statusCode < 500) {
      await reply.status(statusCode).send({ error: { code: "HTTP_REQUEST_ERROR", message, module: "api", correlationId: request.id } });
      return;
    }

    request.log.error({ error }, "Unhandled ModelDock API error");
    await reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Unexpected ModelDock API error", module: "api", correlationId: request.id } });
  });

  registerAccountRoutes(app, {
    accounts: dependencies.accounts,
    auditStore: dependencies.auditStore,
    modelAccess: dependencies.modelAccess,
    clock: dependencies.clock,
    requireLogin: options.requireLogin ?? false
  });
  registerChatRoutes(app, {
    chats: dependencies.chats,
    ollama: dependencies.ollama,
    modelAccess: dependencies.modelAccess,
    clock: dependencies.clock
  });
  registerDevicesRoutes(app, { link, auditStore: dependencies.auditStore, clock: dependencies.clock });

  app.addHook("onClose", async () => {
    await link?.server.close();
    // Windows keeps an open database file locked: release it when the API stops.
    dependencies.storage.close();
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-correlation-id", request.id);
  });

  if (options.webRoot && existsSync(join(options.webRoot, "index.html"))) {
    await app.register(fastifyStatic, {
      root: options.webRoot,
      // The plugin's own Cache-Control would overwrite the one set below.
      cacheControl: false,
      // The page itself must never be cached: after an update it points at the new files.
      setHeaders: (response, path) => {
        if (path.endsWith("index.html")) response.setHeader("cache-control", "no-cache");
      }
    });
  }

  async function readPowerStatus(): Promise<AiServerPowerStatus> {
    const [ollama, runningModels] = await Promise.all([dependencies.ollama.getHealth(), dependencies.ollama.listRunningModels().catch(() => [])]);
    const ollamaReady = ollama.status === "available";
    const state = powerTransition ?? (ollamaReady ? "on" : "off");
    return {
      state,
      ollamaReady,
      loadedModels: runningModels.length,
      message:
        state === "on"
          ? "Ollama is running."
          : state === "starting"
            ? "Ollama is starting."
            : "Ollama is not running: nobody can chat until it starts.",
      updatedAt: dependencies.clock.now().toISOString()
    };
  }

  app.get("/api/health", async () => ({
    status: "ok",
    service: "modeldock-api",
    checkedAt: dependencies.clock.now().toISOString()
  }));

  app.get("/api/system/status", async () => {
    const ollama = await dependencies.ollama.getHealth();
    return buildSystemStatus({
      backend: createComponentHealth({ name: "backend", status: "available", message: "ModelDock API is running" }, dependencies.clock),
      storage: createComponentHealth(
        dependencies.storage.persistent
          ? { name: "storage", status: "available", message: `Database at ${dependencies.storage.location}` }
          : { name: "storage", status: "degraded", message: "In-memory storage: accounts and conversations are lost on restart" },
        dependencies.clock
      ),
      ollama,
      link: link
        ? linkHealth(link, dependencies.clock)
        : createComponentHealth({ name: "link", status: "not_configured", message: "The connection between devices is switched off." }, dependencies.clock),
      checkedAt: dependencies.clock.now().toISOString()
    });
  });

  app.get("/api/system/resources", async (): Promise<SystemResources> => {
    const totalBytes = totalmem();
    const freeBytes = freemem();
    const usedBytes = Math.max(totalBytes - freeBytes, 0);
    return {
      checkedAt: dependencies.clock.now().toISOString(),
      memory: { totalBytes, freeBytes, usedBytes, usedRatio: totalBytes > 0 ? usedBytes / totalBytes : 0 },
      cpu: { model: cpus()[0]?.model.trim() ?? "", cores: cpus().length }
    };
  });

  app.get("/api/system/ollama", async (): Promise<OllamaSetupStatus> => {
    const [health, models] = await Promise.all([dependencies.ollama.getHealth(), dependencies.ollama.listLocalModels().catch(() => [])]);
    const modelsPath = resolveOllamaModelsPath(options);
    return {
      health,
      modelsPath: modelsPath.path,
      pathSource: modelsPath.source,
      pathExists: existsSync(modelsPath.path),
      modelCount: models.length,
      apiBaseUrl: options.ollamaBaseUrl ?? "http://127.0.0.1:11434",
      apiExposesModelsPath: false,
      message: health.status === "available" ? `Ollama is reachable. ${models.length} local model${models.length === 1 ? "" : "s"}.` : health.message
    };
  });

  app.get("/api/server/power", async (): Promise<AiServerPowerStatus> => readPowerStatus());

  /** Starts Ollama, installing it first where the system allows (winget, Homebrew). */
  app.post("/api/server/power/start", async (request): Promise<AiServerPowerStatus> => {
    powerTransition = "starting";
    try {
      if (!(await ensureOllamaIsReady(() => dependencies.ollama.getHealth()))) {
        throw new ModelDockError({
          code: "AI_SERVER_OLLAMA_START_FAILED",
          module: "server-power",
          message: "Ollama could not be started",
          suggestion: "Install Ollama from ollama.com, then try again.",
          httpStatus: 502
        });
      }
      await dependencies.auditStore.append({
        actorId: request.account?.id ?? "system",
        action: "AI_SERVER_STARTED",
        module: "server-power",
        result: "success",
        correlationId: request.id,
        resourceType: "server",
        resourceId: "local"
      });
    } finally {
      powerTransition = null;
    }
    return readPowerStatus();
  });

  /** Unloads every model from memory. Ollama stays on: the next message loads its model again. */
  app.post("/api/server/release-memory", async (request): Promise<AiServerPowerStatus> => {
    const running = await dependencies.ollama.listRunningModels().catch(() => []);
    await Promise.all(running.map((model) => dependencies.ollama.unloadModel({ model: model.name })));
    await dependencies.auditStore.append({
      actorId: request.account?.id ?? "system",
      action: "AI_SERVER_MEMORY_RELEASED",
      module: "server-power",
      result: "success",
      correlationId: request.id,
      resourceType: "server",
      resourceId: "local"
    });
    return readPowerStatus();
  });

  app.get("/api/models", async () => {
    const models = await dependencies.ollama.listLocalModels();
    await syncModelPoliciesWithRuntimeState(dependencies, models);
    return models;
  });

  app.get("/api/models/running", async () => dependencies.ollama.listRunningModels());

  app.post<{ Params: { name: string } }>("/api/models/:name/unload", async (request) => {
    await dependencies.ollama.unloadModel({ model: request.params.name });
    return { unloaded: true };
  });

  app.get("/api/access/model-policies", async () => {
    const models = await dependencies.ollama.listLocalModels().catch(() => []);
    await syncModelPoliciesWithRuntimeState(dependencies, models);
    return {
      users: await dependencies.modelAccess.listUsers(),
      groups: await dependencies.modelAccess.listGroups(),
      models: await dependencies.modelAccess.listPolicies()
    };
  });

  app.put<{ Body: { modelName?: string; enabled?: boolean; loaded?: boolean; groupGrants?: Record<string, boolean> } }>(
    "/api/access/model-policies",
    async (request) => {
      const modelName = request.body.modelName?.trim();
      if (!modelName) {
        throw new ModelDockError({ code: "INVALID_INPUT", module: "access-control", message: "Model name is required" });
      }

      await dependencies.modelAccess.ensurePolicy(modelName);
      if (typeof request.body.loaded === "boolean") {
        if (request.body.loaded) await dependencies.ollama.loadModel({ model: modelName });
        else await dependencies.ollama.unloadModel({ model: modelName });
      }

      const policy = await dependencies.modelAccess.updatePolicy({
        modelName,
        enabled: request.body.enabled,
        loaded: request.body.loaded,
        groupGrants: request.body.groupGrants
      });
      await dependencies.auditStore.append({
        actorId: request.account?.id ?? "system",
        action: "MODEL_ACCESS_POLICY_UPDATED",
        module: "access-control",
        result: "success",
        correlationId: request.id,
        resourceType: "model",
        resourceId: modelName
      });
      return policy;
    }
  );

  app.post<{ Body: { name?: string } }>("/api/models/pull", async (request, reply) => {
    const name = request.body.name?.trim();
    if (!name) {
      throw new ModelDockError({ code: "INVALID_INPUT", module: "models", message: "Model name is required" });
    }
    const job: ModelPullJob = {
      id: dependencies.ids.createId("pull"),
      model: name,
      status: "queued",
      message: "Queued",
      createdAt: dependencies.clock.now().toISOString(),
      updatedAt: dependencies.clock.now().toISOString()
    };
    modelPullJobs.set(job.id, job);
    void runModelPullJob(dependencies, modelPullJobs, job.id, request.id);
    return reply.status(202).send(job);
  });

  app.get<{ Params: { jobId: string } }>("/api/models/pull-jobs/:jobId", async (request) => {
    const job = modelPullJobs.get(request.params.jobId);
    if (!job) {
      throw new ModelDockError({ code: "MODEL_PULL_JOB_NOT_FOUND", module: "models", message: `No pull job exists with id ${request.params.jobId}`, httpStatus: 404 });
    }
    return job;
  });

  app.delete<{ Params: { name: string } }>("/api/models/:name", async (request) => {
    await dependencies.ollama.deleteModel(request.params.name);
    await dependencies.modelAccess.deletePolicy(request.params.name);
    await dependencies.auditStore.append({
      actorId: request.account?.id ?? "system",
      action: "MODEL_DELETE_SUCCEEDED",
      module: "models",
      result: "success",
      correlationId: request.id,
      resourceType: "model",
      resourceId: request.params.name
    });
    return { deleted: true };
  });

  app.post<{ Params: { name: string }; Body: { prompt?: string } }>("/api/models/:name/probe", async (request) =>
    dependencies.ollama.probeModel({
      model: request.params.name,
      prompt: request.body?.prompt ?? "Say hello from ModelDock diagnostics."
    })
  );

  app.get("/api/diagnostics/checks", async () => diagnostics.list().map((check) => ({ id: check.id, label: check.label })));

  app.post<{ Params: { checkId: string } }>("/api/diagnostics/checks/:checkId/run", async (request): Promise<DiagnosticCheckResult> =>
    diagnostics.run(request.params.checkId)
  );

  app.post("/api/diagnostics/run-all", async (request): Promise<DiagnosticCheckResult[]> => {
    const results = await diagnostics.runAll();
    await dependencies.auditStore.append({
      actorId: request.account?.id ?? "system",
      action: "DIAGNOSTIC_RUN_ALL",
      module: "diagnostics",
      result: "success",
      correlationId: request.id
    });
    return results;
  });

  app.get("/api/audit/events", async (): Promise<AuditEvent[]> => dependencies.auditStore.list());

  return app;
}

async function startLink(options: LinkOptions): Promise<LinkRuntime> {
  const identity = await loadOrCreateIdentity(options.dataDir);
  const registry = new LinkRegistry(new FileStateStore(join(options.dataDir, "state.json")));
  const server = await startLinkServer({
    identity,
    registry,
    upstream: { host: "127.0.0.1", port: options.upstreamPort },
    listen: { host: options.listenHost ?? "0.0.0.0", port: options.port },
    allowUnpairedBrowsers: options.allowUnpairedBrowsers
  });
  return { identity, registry, server, allowUnpairedBrowsers: options.allowUnpairedBrowsers };
}

function linkHealth(link: LinkRuntime, clock: Clock): ComponentHealth {
  const addresses = listLanAddresses();
  return createComponentHealth(
    addresses.length > 0
      ? {
          name: "link",
          status: "available",
          message: `Reachable on the local network at ${addresses.map((address) => `${address}:${link.server.port}`).join(", ")}`,
          details: { port: link.server.port, addresses }
        }
      : { name: "link", status: "degraded", message: "Running, but this computer is not on a local network: no device can reach it." },
    clock
  );
}

/**
 * Accounts and conversations always sit on SQLite. With a file, permissions and the audit
 * log move there too and stop being demo data; without one (tests) they stay fake.
 */
function withStorage<T extends ReturnType<typeof createFakeDependencies>>(fakes: T, databasePath: string | undefined) {
  const persistent = Boolean(databasePath);
  const database = openDatabase(databasePath ?? ":memory:");
  const clock = persistent ? { now: () => new Date() } : fakes.clock;

  return {
    ...fakes,
    accounts: new AccountService(new SqliteAccountStore(database), clock),
    chats: new SqliteChatStore(database),
    storage: { persistent, location: databasePath ?? ":memory:", close: () => database.close() },
    ...(persistent
      ? {
          clock,
          // Sequential ids restart at every boot and would collide with rows already in the file.
          auditStore: new SqliteAuditStore(database, clock, { createId: (prefix: string) => `${prefix}_${randomUUID()}` }),
          modelAccess: new SqliteModelAccessStore(database)
        }
      : {})
  };
}

function createRuntimeDependencies(options: BuildAppOptions): RuntimeDependencies {
  const dependencies = withStorage(createFakeDependencies(), options.databasePath);
  const ollamaMode = options.ollamaMode ?? "fake";

  if (options.ollamaGateway) return { ...dependencies, ollama: options.ollamaGateway };
  if (ollamaMode === "fake") return dependencies;

  const clock = dependencies.storage.persistent ? dependencies.clock : { now: () => new Date() };
  return {
    ...dependencies,
    clock,
    ollama: new OllamaHttpGateway(options.ollamaBaseUrl ?? "http://127.0.0.1:11434", clock)
  };
}

function resolveOllamaModelsPath(options: Pick<BuildAppOptions, "ollamaModelsPath">): { path: string; source: OllamaSetupStatus["pathSource"] } {
  const configuredPath = options.ollamaModelsPath?.trim();
  if (configuredPath) return { path: configuredPath, source: "modeldock_env" };

  const ollamaEnvPath = process.env.OLLAMA_MODELS?.trim();
  if (ollamaEnvPath) return { path: ollamaEnvPath, source: "ollama_env" };

  if (platform() === "linux") return { path: "/usr/share/ollama/.ollama/models", source: "default" };
  return { path: join(homedir(), ".ollama", "models"), source: "default" };
}

async function ensureOllamaIsReady(getHealth: () => Promise<ComponentHealth>): Promise<boolean> {
  if ((await getHealth()).status === "available") return true;

  let executable = await findAvailableCommand(resolveOllamaCommandCandidates());
  if (!executable) {
    if (!(await installOllamaForCurrentPlatform()).ok) return false;
    executable = await findAvailableCommand(resolveOllamaCommandCandidates());
  }
  if (!executable) return false;

  const child = spawn(executable, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return waitForHealth(getHealth, 45, 1000);
}

function resolveOllamaCommandCandidates(platformId: NodeJS.Platform = platform(), homeDirectory: string = homedir()): string[] {
  if (platformId === "win32") {
    return [
      "ollama.exe",
      "ollama",
      join(homeDirectory, "AppData", "Local", "Programs", "Ollama", "ollama.exe"),
      join(homeDirectory, "AppData", "Local", "Ollama", "ollama.exe")
    ];
  }
  return ["ollama", "/Applications/Ollama.app/Contents/Resources/ollama", "/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"];
}

async function installOllamaForCurrentPlatform(): Promise<{ ok: boolean }> {
  if (platform() === "win32") {
    const winget = await findAvailableCommand(["winget.exe", "winget"]);
    return winget
      ? runCommand(winget, ["install", "--id", "Ollama.Ollama", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements"], 10 * 60_000)
      : { ok: false };
  }
  if (platform() === "darwin") {
    const brew = await findAvailableCommand(["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "brew"]);
    return brew ? runCommand(brew, ["install", "--cask", "ollama-app"], 10 * 60_000) : { ok: false };
  }
  return { ok: false };
}

async function waitForHealth(getHealth: () => Promise<ComponentHealth>, attempts: number, intervalMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await getHealth()).status === "available") return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok });
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

async function findAvailableCommand(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if ((await runCommand(candidate, ["--version"], 2500)).ok) return candidate;
  }
  return undefined;
}

async function syncModelPoliciesWithRuntimeState(dependencies: RuntimeDependencies, models: Model[]) {
  await Promise.all(
    models.map(async (model) => {
      await dependencies.modelAccess.ensurePolicy(model.name);
      await dependencies.modelAccess.updatePolicy({ modelName: model.name, loaded: model.running });
    })
  );
}

async function runModelPullJob(dependencies: RuntimeDependencies, jobs: Map<string, ModelPullJob>, jobId: string, correlationId: string) {
  const job = jobs.get(jobId);
  if (!job) return;

  updatePullJob(dependencies, jobs, jobId, { status: "running", message: "Starting download" });

  try {
    for await (const item of dependencies.ollama.pullModel({ name: job.model })) {
      updatePullJob(dependencies, jobs, jobId, {
        status: "running",
        message: item.status,
        completedBytes: item.completedBytes,
        totalBytes: item.totalBytes
      });
    }
    await dependencies.modelAccess.ensurePolicy(job.model);
    updatePullJob(dependencies, jobs, jobId, { status: "succeeded", message: "Pull completed" });
    await dependencies.auditStore.append({
      actorId: "system",
      action: "MODEL_PULL_SUCCEEDED",
      module: "models",
      result: "success",
      correlationId,
      resourceType: "model",
      resourceId: job.model
    });
  } catch (error) {
    updatePullJob(dependencies, jobs, jobId, {
      status: "failed",
      message: "Pull failed",
      error: error instanceof Error ? error.message : String(error)
    });
    await dependencies.auditStore.append({
      actorId: "system",
      action: "MODEL_PULL_FAILED",
      module: "models",
      result: "failure",
      correlationId,
      resourceType: "model",
      resourceId: job.model,
      errorCode: error instanceof ModelDockError ? error.code : "UNKNOWN_ERROR"
    });
  }
}

function updatePullJob(
  dependencies: RuntimeDependencies,
  jobs: Map<string, ModelPullJob>,
  jobId: string,
  patch: Partial<Pick<ModelPullJob, "status" | "message" | "completedBytes" | "totalBytes" | "error">>
) {
  const current = jobs.get(jobId);
  if (!current) return;
  jobs.set(jobId, { ...current, ...patch, updatedAt: dependencies.clock.now().toISOString() });
}
