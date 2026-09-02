import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, freemem, homedir, hostname as getOsHostname, platform, totalmem } from "node:os";
import { join, posix } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import {
  buildSystemStatus,
  createComponentHealth,
  ModelDockError,
  type AuditEvent,
  type AuditStore,
  type Clock,
  type ComponentHealth,
  type DiagnosticCheckResult,
  type IdGenerator,
  type Model,
  type ModelAccessStore,
  type ModelPullJob,
  type ModelPullJobStatus,
  type ManagedServerSetupStatus,
  type OllamaSetupStatus,
  type OllamaGateway,
  type OpenWebUISetupStatus,
  type OpenWebUIRuntimeStatus,
  type SystemResources,
  type TailnetDevice,
  type TailscaleGateway,
  type TailscaleSetupStatus
} from "@modeldock/core";
import { createDiagnosticRegistry } from "@modeldock/diagnostics";
import { OllamaHttpGateway } from "@modeldock/ollama-adapter";
import { TailscaleApiGateway, TailscaleCliGateway } from "@modeldock/tailscale-adapter";
import { createFakeDependencies } from "@modeldock/testing";
import {
  prepareOpenWebUIRuntimeBundle,
  resolvePreparedRuntimePythonPath,
  type PreparedOpenWebUIRuntime,
  type RuntimePreparationProgress
} from "./openwebui-runtime.ts";

export type OllamaRuntimeMode = "fake" | "real" | "auto";
export type TailscaleRuntimeMode = "fake" | "real" | "cli" | "api" | "auto";

export interface BuildAppOptions {
  logger?: boolean;
  ollamaBaseUrl?: string;
  ollamaModelsPath?: string;
  ollamaMode?: OllamaRuntimeMode;
  openWebUIApiKey?: string;
  openWebUIBaseUrl?: string;
  openWebUIFetch?: typeof fetch;
  openWebUIRuntime?: OpenWebUIRuntimeController;
  localEnvPath?: string;
  tailscaleApiBaseUrl?: string;
  tailscaleApiToken?: string;
  tailscaleMode?: TailscaleRuntimeMode;
  tailscaleTailnet?: string;
}

interface OpenWebUIRuntimeController {
  getDataDir(): string;
  getLog(): string[];
  hasPreparedRuntime?(): boolean;
  isStartedByModelDock(): boolean;
  isUvAvailable(): Promise<boolean>;
  prepareManagedRuntime?(onProgress?: (progress: RuntimePreparationProgress) => void): Promise<boolean>;
  start(input: {
    compatibilityMode?: boolean;
    dataDir: string;
    executablePath?: string;
    installPath?: string;
    port: number;
  }): Promise<{ started: boolean; message: string }>;
}

const OPEN_WEBUI_COMPATIBILITY_VERSION = "0.11.1";
const OPEN_WEBUI_INTEL_MAC_VERSION = "0.7.2";
const INTEL_MAC_CRYPTOGRAPHY_VERSION = "48.0.1";

export function resolveManagedOpenWebUIRuntimeProfile(
  platformId: NodeJS.Platform = platform(),
  architecture: NodeJS.Architecture = arch(),
  compatibilityMode = false
): {
  extraPackages: string[];
  packageSpec: string;
  profile: "current" | "compatibility" | "intel-mac";
} {
  const platformPackages = platformId === "win32" ? ["pywin32"] : [];

  if (platformId === "darwin" && architecture === "x64") {
    return {
      extraPackages: ["greenlet", "itsdangerous", "beautifulsoup4", `cryptography==${INTEL_MAC_CRYPTOGRAPHY_VERSION}`],
      packageSpec: `open-webui@${OPEN_WEBUI_INTEL_MAC_VERSION}`,
      profile: "intel-mac"
    };
  }

  if (compatibilityMode) {
    return {
      extraPackages: ["greenlet", "itsdangerous", "beautifulsoup4", ...platformPackages],
      packageSpec: `open-webui@${OPEN_WEBUI_COMPATIBILITY_VERSION}`,
      profile: "compatibility"
    };
  }

  return {
    extraPackages: platformPackages,
    packageSpec: "open-webui@latest",
    profile: "current"
  };
}

interface RuntimeDependencies {
  clock: Clock;
  ids: IdGenerator;
  auditStore: AuditStore;
  modelAccess: ModelAccessStore;
  ollama: OllamaGateway;
  tailscale: TailscaleGateway;
  tailscaleLocal: TailscaleGateway;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const dependencies = createRuntimeDependencies(options);
  const diagnostics = createDiagnosticRegistry(dependencies);
  const modelPullJobs = new Map<string, ModelPullJob>();
  const openWebUIRuntime = options.openWebUIRuntime ?? createOpenWebUIRuntimeController();
  const app = Fastify({ logger: options.logger ?? false });
  let managedServerSetup = createInitialManagedServerSetupStatus(dependencies.clock);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-correlation-id", request.id);
  });

  app.get("/api/health", async () => ({
    status: "ok",
    service: "modeldock-api",
    checkedAt: dependencies.clock.now().toISOString()
  }));

  app.get("/api/system/status", async () => {
    const [ollama, tailscale, openWebUI] = await Promise.all([
      dependencies.ollama.getHealth(),
      dependencies.tailscale.getLocalStatus(),
      getOpenWebUIHealth(options.openWebUIBaseUrl, dependencies.clock, options.openWebUIFetch)
    ]);

    return buildSystemStatus({
      backend: createComponentHealth({ name: "backend", status: "available", message: "ModelDock API is running" }, dependencies.clock),
      storage: createComponentHealth({ name: "storage", status: "available", message: "In-memory storage is writable" }, dependencies.clock),
      ollama,
      tailscale,
      openWebUI,
      checkedAt: dependencies.clock.now().toISOString()
    });
  });

  app.get("/api/system/resources", async (): Promise<SystemResources> => {
    const totalBytes = totalmem();
    const freeBytes = freemem();
    const usedBytes = Math.max(totalBytes - freeBytes, 0);

    return {
      checkedAt: dependencies.clock.now().toISOString(),
      memory: {
        totalBytes,
        freeBytes,
        usedBytes,
        usedRatio: totalBytes > 0 ? usedBytes / totalBytes : 0
      },
      gpu: {
        status: "not_configured",
        message: "GPU telemetry adapter is not configured yet"
      },
      inferenceProjection: {
        tokensPerSecond: {
          min: 18,
          max: 34
        },
        confidence: "estimated",
        message: "Projection based on the current fake model profile; real probes will replace this later"
      }
    };
  });

  app.get("/api/system/events", async (): Promise<AuditEvent[]> => dependencies.auditStore.list());

  app.get("/api/models", async () => {
    const models = await dependencies.ollama.listLocalModels();

    await syncModelPoliciesWithRuntimeState(dependencies, models);

    return models;
  });
  app.get("/api/integrations/ollama/status", async () => dependencies.ollama.getHealth());
  app.get("/api/integrations/open-webui/status", async () => getOpenWebUIHealth(options.openWebUIBaseUrl, dependencies.clock, options.openWebUIFetch));

  app.get("/api/setup/server", async (): Promise<ManagedServerSetupStatus> => {
    if (managedServerSetup.state === "idle" && options.openWebUIApiKey?.trim() && options.openWebUIBaseUrl?.trim()) {
      const baseUrl = normalizeBaseUrl(options.openWebUIBaseUrl);

      if (baseUrl) {
        const health = await getOpenWebUIHealth(baseUrl, dependencies.clock, options.openWebUIFetch);

        if (health.status === "available") {
          const adminCheck = await verifyOpenWebUIAdminAccess({
            apiKey: options.openWebUIApiKey,
            baseUrl,
            fetchImpl: options.openWebUIFetch ?? fetch
          });

          if (adminCheck.adminVerified) {
            managedServerSetup = {
              state: "succeeded",
              phase: "ready",
              progress: 100,
              message: "The existing local AI server and administrator chat are ready.",
              ollamaReady: (await dependencies.ollama.getHealth()).status === "available",
              chatReady: true,
              adminReady: true,
              chatUrl: baseUrl,
              updatedAt: dependencies.clock.now().toISOString()
            };
          }
        }
      }
    }

    return managedServerSetup;
  });

  app.post<{ Body: { adminEmail?: string; adminName?: string; adminPassword?: string } }>("/api/setup/server", async (request, reply) => {
    const adminEmail = request.body.adminEmail?.trim().toLowerCase();
    const adminName = request.body.adminName?.trim();
    const adminPassword = request.body.adminPassword;

    if (!adminName || !adminEmail || !adminEmail.includes("@") || !adminPassword || adminPassword.length < 8) {
      throw new ModelDockError({
        code: "INVALID_INPUT",
        module: "setup",
        message: "Name, a valid email and a password of at least 8 characters are required"
      });
    }

    if (managedServerSetup.state === "running") {
      return reply.status(202).send(managedServerSetup);
    }

    const startedAt = dependencies.clock.now().toISOString();
    managedServerSetup = {
      state: "running",
      phase: "checking",
      progress: 5,
      message: "Checking the components already available on this computer.",
      ollamaReady: false,
      chatReady: false,
      adminReady: false,
      chatUrl: "http://127.0.0.1:8080",
      startedAt,
      updatedAt: startedAt
    };

    void runManagedServerSetup({
      admin: { email: adminEmail, name: adminName, password: adminPassword },
      clock: dependencies.clock,
      fetchImpl: options.openWebUIFetch ?? fetch,
      getOllamaHealth: () => dependencies.ollama.getHealth(),
      localEnvPath: options.localEnvPath,
      openWebUIRuntime,
      update(next) {
        managedServerSetup = {
          ...managedServerSetup,
          ...next,
          updatedAt: dependencies.clock.now().toISOString()
        };
      }
    })
      .then(async (result) => {
        options.openWebUIApiKey = result.apiKey;
        options.openWebUIBaseUrl = result.baseUrl;
        managedServerSetup = {
          ...managedServerSetup,
          state: "succeeded",
          phase: "ready",
          progress: 100,
          message: "The local AI server and administrator chat are ready.",
          ollamaReady: true,
          chatReady: true,
          adminReady: true,
          chatUrl: result.baseUrl,
          updatedAt: dependencies.clock.now().toISOString()
        };
      })
      .catch((error) => {
        managedServerSetup = {
          ...managedServerSetup,
          state: "failed",
          phase: "failed",
          message: error instanceof Error ? error.message : "Server preparation failed.",
          updatedAt: dependencies.clock.now().toISOString()
        };
      });

    return reply.status(202).send(managedServerSetup);
  });

  app.get("/api/setup/ollama", async (): Promise<OllamaSetupStatus> => {
    const [health, models] = await Promise.all([
      dependencies.ollama.getHealth(),
      dependencies.ollama.listLocalModels().catch(() => [])
    ]);
    const modelsPath = resolveOllamaModelsPath(options);

    return {
      health,
      modelsPath: modelsPath.path,
      pathSource: modelsPath.source,
      pathExists: existsSync(modelsPath.path),
      modelCount: models.length,
      apiBaseUrl: options.ollamaBaseUrl ?? "http://127.0.0.1:11434",
      apiExposesModelsPath: false,
      message:
        health.status === "available"
          ? `Ollama is reachable. ${models.length} local model${models.length === 1 ? "" : "s"} detected.`
          : health.message
    };
  });

  app.get("/api/setup/tailscale", async (): Promise<TailscaleSetupStatus> => {
    let health = await dependencies.tailscaleLocal.getLocalStatus();
    const accessDenied = getBooleanDetail(health, "accessDenied");

    if (accessDenied) {
      const apiFallback = await findCurrentMachineThroughTailscaleApi(dependencies);

      if (apiFallback) {
        health = apiFallback;
      }
    }

    const tailnetIp = getStringDetail(health, "tailnetIp");
    const addresses = getStringArrayDetail(health, "addresses");
    const normalizedAddresses = addresses.length > 0 ? addresses : tailnetIp ? [tailnetIp] : [];
    const backendState = getStringDetail(health, "backendState");
    const tailnet = getStringDetail(health, "tailnet");
    const hostname = getStringDetail(health, "hostname");
    const localAccessDenied = getBooleanDetail(health, "accessDenied");
    const installed = health.status !== "unavailable" || accessDenied;
    const loggedIn = health.status === "available";
    const suggestedServerUrl = normalizedAddresses[0] ? `http://${normalizedAddresses[0]}:4173` : undefined;

    return {
      health,
      installed,
      loggedIn,
      backendState,
      tailnet,
      hostname,
      addresses: normalizedAddresses,
      suggestedServerUrl,
      apiRequiredForDeviceWrites: true,
      message: buildTailscaleSetupMessage({ accessDenied: localAccessDenied, health, installed, loggedIn, suggestedServerUrl })
    };
  });

  app.post("/api/setup/tailscale/login", async () => startTailscaleLoginForCurrentPlatform());

  app.get<{ Querystring: { baseUrl?: string } }>("/api/setup/open-webui", async (request): Promise<OpenWebUISetupStatus> => {
    const baseUrl = normalizeBaseUrl(request.query.baseUrl) ?? normalizeBaseUrl(options.openWebUIBaseUrl);
    const health = await getOpenWebUIHealth(baseUrl, dependencies.clock, options.openWebUIFetch);
    const apiKey = options.openWebUIApiKey?.trim();
    const apiKeyConfigured = Boolean(apiKey);

    if (!baseUrl) {
      return {
        health,
        reachable: false,
        apiKeyConfigured,
        adminVerified: false,
        message: "Open WebUI URL is not configured yet."
      };
    }

    if (health.status !== "available") {
      return {
        health,
        baseUrl,
        reachable: false,
        apiKeyConfigured,
        adminVerified: false,
        message: health.message
      };
    }

    if (!apiKey) {
      return {
        health,
        baseUrl,
        reachable: true,
        apiKeyConfigured: false,
        adminVerified: false,
        message: "Open WebUI is reachable. Configure an admin API key to enable user and permission management."
      };
    }

    const adminCheck = await verifyOpenWebUIAdminAccess({
      apiKey,
      baseUrl,
      fetchImpl: options.openWebUIFetch ?? fetch
    });

    return {
      health: adminCheck.health ?? health,
      baseUrl,
      reachable: true,
      apiKeyConfigured: true,
      adminVerified: adminCheck.adminVerified,
      authenticatedUser: adminCheck.authenticatedUser,
      modelCount: adminCheck.modelCount,
      message: adminCheck.message
    };
  });

  app.get<{ Querystring: { baseUrl?: string; installPath?: string } }>("/api/setup/open-webui/runtime", async (request): Promise<OpenWebUIRuntimeStatus> => {
    const baseUrl = resolveOpenWebUIBaseUrl(request.query.baseUrl, options.openWebUIBaseUrl);

    return getOpenWebUIRuntimeStatus({
      baseUrl,
      clock: dependencies.clock,
      fetchImpl: options.openWebUIFetch,
      installPath: request.query.installPath,
      runtime: openWebUIRuntime
    });
  });

  app.post<{ Body: { baseUrl?: string; installPath?: string } }>("/api/setup/open-webui/start", async (request): Promise<OpenWebUIRuntimeStatus> => {
    const baseUrl = resolveOpenWebUIBaseUrl(request.body.baseUrl, options.openWebUIBaseUrl);
    const url = new URL(baseUrl);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const dataDir = openWebUIRuntime.getDataDir();
    const localInstall = resolveOpenWebUILocalInstall(request.body.installPath);
    const currentStatus = await getOpenWebUIRuntimeStatus({
      baseUrl,
      clock: dependencies.clock,
      fetchImpl: options.openWebUIFetch,
      installPath: request.body.installPath,
      runtime: openWebUIRuntime
    });

    if (currentStatus.running) {
      options.openWebUIBaseUrl = baseUrl;
      return currentStatus;
    }

    if (!localInstall.installed) {
      const preparedRuntimeAvailable = (await openWebUIRuntime.prepareManagedRuntime?.()) ?? false;

      if (!preparedRuntimeAvailable) {
        await ensureUvIsAvailable(openWebUIRuntime);
      }
    }

    const startResult = await openWebUIRuntime.start({
      dataDir,
      executablePath: localInstall.executablePath,
      installPath: localInstall.installPath,
      port
    });
    options.openWebUIBaseUrl = baseUrl;

    if (!startResult.started) {
      const uvAvailable = await openWebUIRuntime.isUvAvailable();
      const managedRuntimeAvailable = openWebUIRuntime.hasPreparedRuntime?.() ?? false;

      return {
        health: createComponentHealth(
          {
            name: "open-webui",
            status: "unavailable",
            message: startResult.message,
            details: { baseUrl }
          },
          dependencies.clock
        ),
        baseUrl,
        dataDir,
        executablePath: localInstall.executablePath,
        installPath: localInstall.installPath,
        installed: localInstall.installed,
        port,
        managedRuntimeAvailable,
        uvAvailable,
        running: false,
        startedByModelDock: openWebUIRuntime.isStartedByModelDock(),
        state: managedRuntimeAvailable || uvAvailable ? "not_running" : "tool_missing",
        log: openWebUIRuntime.getLog(),
        message: startResult.message
      };
    }

    return getOpenWebUIRuntimeStatus({
      baseUrl,
      clock: dependencies.clock,
      fetchImpl: options.openWebUIFetch,
      installPath: request.body.installPath,
      runtime: openWebUIRuntime
    });
  });

  app.post<{ Body: { apiKey?: string; baseUrl?: string } }>("/api/setup/open-webui/api-key", async (request): Promise<OpenWebUISetupStatus> => {
    const apiKey = request.body.apiKey?.trim();
    const baseUrl = normalizeBaseUrl(request.body.baseUrl) ?? normalizeBaseUrl(options.openWebUIBaseUrl);

    if (!apiKey) {
      throw new ModelDockError({
        code: "INVALID_INPUT",
        module: "open-webui",
        message: "Open WebUI API key is required"
      });
    }

    if (!baseUrl) {
      throw new ModelDockError({
        code: "INVALID_INPUT",
        module: "open-webui",
        message: "Open WebUI URL is required before saving the API key"
      });
    }

    await upsertLocalEnvValues(
      {
        MODELDOCK_OPENWEBUI_API_KEY: apiKey,
        MODELDOCK_OPENWEBUI_BASE_URL: baseUrl
      },
      options.localEnvPath
    );

    options.openWebUIApiKey = apiKey;
    options.openWebUIBaseUrl = baseUrl;

    const health = await getOpenWebUIHealth(baseUrl, dependencies.clock, options.openWebUIFetch);

    if (health.status !== "available") {
      return {
        health,
        baseUrl,
        reachable: false,
        apiKeyConfigured: true,
        adminVerified: false,
        message: health.message
      };
    }

    const adminCheck = await verifyOpenWebUIAdminAccess({
      apiKey,
      baseUrl,
      fetchImpl: options.openWebUIFetch ?? fetch
    });

    return {
      health: adminCheck.health ?? health,
      baseUrl,
      reachable: true,
      apiKeyConfigured: true,
      adminVerified: adminCheck.adminVerified,
      authenticatedUser: adminCheck.authenticatedUser,
      modelCount: adminCheck.modelCount,
      message: adminCheck.message
    };
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

  app.put<{
    Body: {
      modelName?: string;
      enabled?: boolean;
      loaded?: boolean;
      groupGrants?: Record<string, boolean>;
    };
  }>("/api/access/model-policies", async (request) => {
    const modelName = request.body.modelName?.trim();

    if (!modelName) {
      throw new ModelDockError({
        code: "INVALID_INPUT",
        module: "access-control",
        message: "Model name is required"
      });
    }

    await dependencies.modelAccess.ensurePolicy(modelName);

    if (typeof request.body.loaded === "boolean") {
      if (request.body.loaded) {
        await dependencies.ollama.loadModel({ model: modelName });
      } else {
        await dependencies.ollama.unloadModel({ model: modelName });
      }
    }

    const policy = await dependencies.modelAccess.updatePolicy({
      modelName,
      enabled: request.body.enabled,
      loaded: request.body.loaded,
      groupGrants: request.body.groupGrants
    });

    await dependencies.auditStore.append({
      actorId: "system",
      action: "MODEL_ACCESS_POLICY_UPDATED",
      module: "access-control",
      result: "success",
      correlationId: request.id,
      resourceType: "model",
      resourceId: modelName
    });

    return policy;
  });

  app.post<{ Body: { name?: string } }>("/api/models/pull", async (request, reply) => {
    const name = request.body.name?.trim();

    if (!name) {
      throw new ModelDockError({
        code: "INVALID_INPUT",
        module: "models",
        message: "Model name is required"
      });
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
      throw new ModelDockError({
        code: "MODEL_PULL_JOB_NOT_FOUND",
        module: "models",
        message: `No pull job exists with id ${request.params.jobId}`
      });
    }

    return job;
  });

  app.delete<{ Params: { name: string } }>("/api/models/:name", async (request) => {
    await dependencies.ollama.deleteModel(request.params.name);
    await dependencies.modelAccess.deletePolicy(request.params.name);

    await dependencies.auditStore.append({
      actorId: "system",
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
      prompt: request.body.prompt ?? "Say hello from ModelDock diagnostics."
    })
  );

  app.get("/api/network/tailscale/status", async () => dependencies.tailscale.getLocalStatus());
  app.get("/api/network/tailscale/devices", async () => dependencies.tailscale.listDevices().catch(() => []));
  app.put<{ Params: { deviceId: string }; Body: { authorized?: boolean } }>("/api/network/tailscale/devices/:deviceId", async (request) => {
    if (typeof request.body.authorized !== "boolean") {
      throw new ModelDockError({
        code: "INVALID_INPUT",
        module: "tailscale-adapter",
        message: "Device authorization state is required"
      });
    }

    const device = await dependencies.tailscale.updateDeviceAuthorization({
      deviceId: request.params.deviceId,
      authorized: request.body.authorized
    });

    await dependencies.auditStore.append({
      actorId: "system",
      action: "TAILSCALE_DEVICE_AUTHORIZATION_UPDATED",
      module: "network",
      result: "success",
      correlationId: request.id,
      resourceType: "tailnet-device",
      resourceId: request.params.deviceId
    });

    return device;
  });

  app.get("/api/diagnostics/checks", async () =>
    diagnostics.list().map((check) => ({
      id: check.id,
      label: check.label
    }))
  );

  app.post<{ Params: { checkId: string } }>("/api/diagnostics/checks/:checkId/run", async (request): Promise<DiagnosticCheckResult> =>
    diagnostics.run(request.params.checkId)
  );

  app.post("/api/diagnostics/run-all", async (request): Promise<DiagnosticCheckResult[]> => {
    const results = await diagnostics.runAll();
    await dependencies.auditStore.append({
      actorId: "system",
      action: "DIAGNOSTIC_RUN_ALL",
      module: "diagnostics",
      result: "success",
      correlationId: request.id
    });
    return results;
  });

  app.get("/api/audit/events", async (): Promise<AuditEvent[]> => dependencies.auditStore.list());

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ModelDockError) {
      await reply.status(400).send({
        error: {
          code: error.code,
          message: error.message,
          module: error.module,
          suggestion: error.suggestion,
          correlationId: request.id
        }
      });
      return;
    }

    const httpError = error as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof httpError.statusCode === "number" ? httpError.statusCode : 500;
    const message = typeof httpError.message === "string" ? httpError.message : "HTTP request error";

    if (statusCode < 500) {
      await reply.status(statusCode).send({
        error: {
          code: "HTTP_REQUEST_ERROR",
          message,
          module: "api",
          correlationId: request.id
        }
      });
      return;
    }

    request.log.error({ error }, "Unhandled ModelDock API error");
    await reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected ModelDock API error",
        module: "api",
        correlationId: request.id
      }
    });
  });

  return app;
}

function createRuntimeDependencies(options: BuildAppOptions): RuntimeDependencies {
  const dependencies = createFakeDependencies();
  const ollamaMode = options.ollamaMode ?? "fake";
  const tailscaleMode = options.tailscaleMode ?? "fake";

  if (ollamaMode === "fake" && tailscaleMode === "fake") {
    return {
      ...dependencies,
      tailscaleLocal: dependencies.tailscale
    };
  }

  const clock = {
    now: () => new Date()
  };

  return {
    ...dependencies,
    clock,
    ollama: ollamaMode === "fake" ? dependencies.ollama : new OllamaHttpGateway(options.ollamaBaseUrl ?? "http://127.0.0.1:11434", clock),
    tailscale: createTailscaleGateway({
      apiBaseUrl: options.tailscaleApiBaseUrl,
      apiToken: options.tailscaleApiToken,
      clock,
      fake: dependencies.tailscale,
      mode: tailscaleMode,
      tailnet: options.tailscaleTailnet
    }),
    tailscaleLocal: tailscaleMode === "fake" ? dependencies.tailscale : new TailscaleCliGateway(clock)
  };
}

function createTailscaleGateway({
  apiBaseUrl,
  apiToken,
  clock,
  fake,
  mode,
  tailnet
}: {
  apiBaseUrl?: string;
  apiToken?: string;
  clock: Clock;
  fake: TailscaleGateway;
  mode: TailscaleRuntimeMode;
  tailnet?: string;
}): TailscaleGateway {
  if (mode === "fake") {
    return fake;
  }

  if (mode === "api" || (mode === "auto" && apiToken?.trim())) {
    return new TailscaleApiGateway({
      apiToken,
      baseUrl: apiBaseUrl,
      clock,
      tailnet
    });
  }

  return new TailscaleCliGateway(clock);
}

function resolveOllamaModelsPath(options: Pick<BuildAppOptions, "ollamaModelsPath">): {
  path: string;
  source: OllamaSetupStatus["pathSource"];
} {
  const configuredPath = options.ollamaModelsPath?.trim();

  if (configuredPath) {
    return {
      path: configuredPath,
      source: "modeldock_env"
    };
  }

  const ollamaEnvPath = process.env.OLLAMA_MODELS?.trim();

  if (ollamaEnvPath) {
    return {
      path: ollamaEnvPath,
      source: "ollama_env"
    };
  }

  if (platform() === "linux") {
    return {
      path: "/usr/share/ollama/.ollama/models",
      source: "default"
    };
  }

  return {
    path: join(homedir(), ".ollama", "models"),
    source: "default"
  };
}

function getStringDetail(health: ComponentHealth, key: string): string | undefined {
  const value = health.details?.[key];

  return typeof value === "string" && value.trim() ? value : undefined;
}

function getStringArrayDetail(health: ComponentHealth, key: string): string[] {
  const value = health.details?.[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function getBooleanDetail(health: ComponentHealth, key: string): boolean {
  return health.details?.[key] === true;
}

async function findCurrentMachineThroughTailscaleApi(dependencies: RuntimeDependencies): Promise<ComponentHealth | null> {
  try {
    const localHostname = getOsHostname();
    const devices = await dependencies.tailscale.listDevices();
    const device = findLocalTailnetDevice(devices, localHostname);

    if (!device) {
      return null;
    }

    return createComponentHealth(
      {
        name: "tailscale",
        status: device.online === false ? "degraded" : "available",
        message: device.online === false ? "Tailscale device is registered but appears offline" : "Tailscale is connected",
        details: {
          verificationSource: "api_device_match",
          localStatusAccess: "denied",
          localHostname,
          hostname: device.hostname,
          addresses: device.addresses,
          authorized: device.authorized,
          online: device.online,
          os: device.os
        }
      },
      dependencies.clock
    );
  } catch {
    return null;
  }
}

function findLocalTailnetDevice(devices: TailnetDevice[], localHostname: string): TailnetDevice | undefined {
  const normalizedLocalHostname = normalizeHostname(localHostname);

  return devices.find((device) => normalizeHostname(device.hostname) === normalizedLocalHostname);
}

function normalizeHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(".")[0]!
    .replace(/[^a-z0-9-]/g, "");
}

function buildTailscaleSetupMessage({
  accessDenied,
  health,
  installed,
  loggedIn,
  suggestedServerUrl
}: {
  accessDenied: boolean;
  health: ComponentHealth;
  installed: boolean;
  loggedIn: boolean;
  suggestedServerUrl?: string;
}): string {
  if (!installed) {
    return "Tailscale is not installed or the CLI is not reachable.";
  }

  if (accessDenied) {
    return "Tailscale is installed, but Windows denied access to the local Tailscale status.";
  }

  if (!loggedIn) {
    return "Tailscale is installed, but sign-in is not complete on this machine.";
  }

  if (suggestedServerUrl) {
    return `Tailscale is connected. Suggested server URL: ${suggestedServerUrl}.`;
  }

  return health.message;
}

interface OpenWebUIAuthProfile {
  id?: string;
  name?: string;
  email?: string;
  role?: string;
}

interface VerifyOpenWebUIAdminAccessInput {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
}

interface VerifyOpenWebUIAdminAccessResult {
  adminVerified: boolean;
  authenticatedUser?: OpenWebUISetupStatus["authenticatedUser"];
  health?: ComponentHealth;
  modelCount?: number;
  message: string;
}

interface GetOpenWebUIRuntimeStatusInput {
  baseUrl: string;
  clock: Clock;
  fetchImpl?: typeof fetch;
  installPath?: string;
  runtime: OpenWebUIRuntimeController;
}

async function getOpenWebUIRuntimeStatus(input: GetOpenWebUIRuntimeStatusInput): Promise<OpenWebUIRuntimeStatus> {
  const [health, uvAvailable] = await Promise.all([
    getOpenWebUIHealth(input.baseUrl, input.clock, input.fetchImpl),
    input.runtime.isUvAvailable()
  ]);
  const localInstall = resolveOpenWebUILocalInstall(input.installPath);
  const running = health.status === "available";
  const startedByModelDock = input.runtime.isStartedByModelDock();
  const managedRuntimeAvailable = input.runtime.hasPreparedRuntime?.() ?? false;
  const installerAvailable = managedRuntimeAvailable || uvAvailable;

  return {
    health,
    baseUrl: input.baseUrl,
    dataDir: input.runtime.getDataDir(),
    executablePath: localInstall.executablePath,
    installPath: localInstall.installPath,
    installed: localInstall.installed,
    managedRuntimeAvailable,
    port: readPortFromBaseUrl(input.baseUrl),
    uvAvailable,
    running,
    startedByModelDock,
    state: running ? "running" : startedByModelDock ? "starting" : installerAvailable ? "not_running" : "tool_missing",
    log: input.runtime.getLog(),
    message: running
      ? "Open WebUI is reachable."
      : startedByModelDock
        ? "Open WebUI is starting."
        : localInstall.installed
        ? "Open WebUI is installed but not running yet."
        : installerAvailable
        ? "Open WebUI is not running yet."
        : "The installer runtime is not available yet."
  };
}

async function getOpenWebUIHealth(baseUrl: string | undefined, clock: Clock, fetchImpl: typeof fetch = fetch): Promise<ComponentHealth> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!normalizedBaseUrl) {
    return createComponentHealth(
      {
        name: "open-webui",
        status: "not_configured",
        message: "Open WebUI URL is not configured yet"
      },
      clock
    );
  }

  try {
    const response = await fetchImpl(normalizedBaseUrl, {
      method: "GET",
      signal: AbortSignal.timeout(1500)
    });

    return createComponentHealth(
      {
        name: "open-webui",
        status: response.ok ? "available" : "degraded",
        message: response.ok ? "Open WebUI is reachable" : `Open WebUI responded with HTTP ${response.status}`,
        details: {
          baseUrl: normalizedBaseUrl,
          statusCode: response.status
        }
      },
      clock
    );
  } catch (error) {
    return createComponentHealth(
      {
        name: "open-webui",
        status: "unavailable",
        message: "Open WebUI is not reachable",
        details: {
          baseUrl: normalizedBaseUrl,
          error: error instanceof Error ? error.message : String(error)
        }
      },
      clock
    );
  }
}

async function verifyOpenWebUIAdminAccess(input: VerifyOpenWebUIAdminAccessInput): Promise<VerifyOpenWebUIAdminAccessResult> {
  const headers = {
    authorization: `Bearer ${input.apiKey}`,
    accept: "application/json"
  };

  try {
    const profileResponse = await input.fetchImpl(`${input.baseUrl}/api/v1/auths/`, {
      headers,
      method: "GET",
      signal: AbortSignal.timeout(2000)
    });

    if (profileResponse.status === 401 || profileResponse.status === 403) {
      return {
        adminVerified: false,
        message: "Open WebUI API key is configured but was rejected."
      };
    }

    if (!profileResponse.ok) {
      return {
        adminVerified: false,
        message: `Open WebUI auth probe responded with HTTP ${profileResponse.status}.`
      };
    }

    const authenticatedUser = (await profileResponse.json()) as OpenWebUIAuthProfile;
    const isAdmin = authenticatedUser.role === "admin";
    const modelCount = await readOpenWebUIModelCount(input.baseUrl, headers, input.fetchImpl);

    return {
      adminVerified: isAdmin,
      authenticatedUser,
      modelCount,
      message: isAdmin
        ? "Open WebUI admin API access is ready."
        : "Open WebUI API key is valid, but it does not belong to an admin user."
    };
  } catch (error) {
    return {
      adminVerified: false,
      message: `Open WebUI admin API check failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function readOpenWebUIModelCount(baseUrl: string, headers: HeadersInit, fetchImpl: typeof fetch): Promise<number | undefined> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/models`, {
      headers,
      method: "GET",
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as unknown;

    if (Array.isArray(payload)) {
      return payload.length;
    }

    if (payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)) {
      return (payload as { data: unknown[] }).data.length;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalizedBaseUrl = baseUrl?.trim().replace(/\/$/, "");

  return normalizedBaseUrl || undefined;
}

function resolveOpenWebUIBaseUrl(requestedBaseUrl: string | undefined, configuredBaseUrl: string | undefined): string {
  return normalizeBaseUrl(requestedBaseUrl) ?? normalizeBaseUrl(configuredBaseUrl) ?? "http://127.0.0.1:8080";
}

function readPortFromBaseUrl(baseUrl: string): number {
  try {
    const url = new URL(baseUrl);
    return Number(url.port || (url.protocol === "https:" ? 443 : 80));
  } catch {
    return 8080;
  }
}

export function resolveOpenWebUILocalInstall(
  installPath: string | undefined,
  platformId: NodeJS.Platform = platform()
): {
  executablePath?: string;
  installPath?: string;
  installed: boolean;
} {
  const normalizedInstallPath = installPath?.trim();

  if (!normalizedInstallPath) {
    return { installed: false };
  }

  const candidates = resolveOpenWebUIExecutableCandidates(normalizedInstallPath, platformId);
  const executablePath = candidates.find((candidate) => existsSync(candidate));

  return {
    executablePath,
    installPath: normalizedInstallPath,
    installed: Boolean(executablePath)
  };
}

export function resolveOpenWebUIExecutableCandidates(installPath: string, platformId: NodeJS.Platform = platform()): string[] {
  if (platformId === "win32") {
    return [
      join(installPath, "venv", "Scripts", "open-webui.exe"),
      join(installPath, ".venv", "Scripts", "open-webui.exe"),
      join(installPath, "open-webui.exe"),
      join(installPath, "Scripts", "open-webui.exe")
    ];
  }

  return [
    join(installPath, "venv", "bin", "open-webui"),
    join(installPath, ".venv", "bin", "open-webui"),
    join(installPath, "bin", "open-webui"),
    join(installPath, "open-webui")
  ];
}

function createOpenWebUIRuntimeController(): OpenWebUIRuntimeController {
  const dataDir = resolveOpenWebUIDataDir();
  const log: string[] = [];
  let processHandle: ChildProcessWithoutNullStreams | undefined;
  let preparedRuntime: PreparedOpenWebUIRuntime | undefined;

  function appendLog(line: string) {
    const normalizedLine = line.trim();

    if (!normalizedLine) {
      return;
    }

    log.push(normalizedLine);
    log.splice(0, Math.max(log.length - 12, 0));
  }

  return {
    getDataDir: () => dataDir,
    getLog: () => [...log],
    hasPreparedRuntime: () => Boolean(preparedRuntime),
    isStartedByModelDock: () => Boolean(processHandle && processHandle.exitCode === null),
    async isUvAvailable() {
      const result = await runFirstAvailableCommand(resolveUvCommandCandidates(), ["--version"], 2500);

      return result.ok;
    },
    async prepareManagedRuntime(onProgress) {
      if (preparedRuntime) {
        onProgress?.({ message: "The prepared chat runtime is ready.", percent: 100 });
        return true;
      }

      try {
        preparedRuntime = await prepareOpenWebUIRuntimeBundle({ onProgress });

        if (!preparedRuntime) {
          appendLog("No prepared Open WebUI runtime is available for this platform. Using the installer fallback.");
          return false;
        }

        appendLog(`Prepared Open WebUI runtime ${preparedRuntime.version} is ready for ${preparedRuntime.target}.`);
        return true;
      } catch (error) {
        appendLog(
          `Prepared Open WebUI runtime is unavailable; using the installer fallback. ${error instanceof Error ? error.message : String(error)}`
        );
        preparedRuntime = undefined;
        return false;
      }
    },
    async start(input) {
      if (processHandle && processHandle.exitCode === null) {
        return { started: true, message: "Open WebUI is already starting from ModelDock." };
      }

      const usePreparedRuntime = Boolean(!input.executablePath && preparedRuntime && !input.compatibilityMode);
      const command = input.executablePath
        ? input.executablePath
        : usePreparedRuntime
          ? preparedRuntime?.pythonPath
          : await findAvailableCommand(resolveUvxCommandCandidates());

      if (!command) {
        appendLog("uvx was not found on this machine.");
        return { started: false, message: "Open WebUI cannot start because uvx is not available." };
      }

      if (!input.executablePath) {
        await mkdir(input.dataDir, { recursive: true });
      }

      const serveArgs = ["serve", "--host", "0.0.0.0", "--port", String(input.port)];
      const runtimeProfile = resolveManagedOpenWebUIRuntimeProfile(platform(), arch(), input.compatibilityMode);
      const managedArgs = [
        "--python",
        "3.11",
        ...runtimeProfile.extraPackages.flatMap((packageName) => ["--with", packageName]),
        runtimeProfile.packageSpec,
        ...serveArgs
      ];
      const commandArgs = input.executablePath
        ? serveArgs
        : usePreparedRuntime
          ? ["-c", "from open_webui import app; app()", ...serveArgs]
          : managedArgs;

      appendLog(
        input.executablePath
          ? `Starting Open WebUI from ${input.installPath ?? "local install"}.`
          : usePreparedRuntime
            ? `Starting the verified Open WebUI runtime ${preparedRuntime?.version ?? ""}.`
            : runtimeProfile.profile === "intel-mac"
              ? `Starting Open WebUI ${OPEN_WEBUI_INTEL_MAC_VERSION}, the compatible runtime for Intel Macs.`
              : runtimeProfile.profile === "compatibility"
                ? `Retrying Open WebUI with the compatible ${OPEN_WEBUI_COMPATIBILITY_VERSION} runtime.`
                : "Starting Open WebUI from ModelDock."
      );
      processHandle = spawn(command, commandArgs, {
        env: {
          ...process.env,
          DATA_DIR: input.dataDir,
          ENABLE_API_KEYS: "true",
          ENABLE_SIGNUP: "false",
          OLLAMA_BASE_URL: "http://127.0.0.1:11434",
          ...(usePreparedRuntime && preparedRuntime
            ? {
                PYTHONPATH: resolvePreparedRuntimePythonPath(
                  preparedRuntime.sitePackagesPath,
                  platform(),
                  process.env.PYTHONPATH
                )
              }
            : {}),
          PORT: String(input.port)
        },
        cwd: input.executablePath ? input.installPath : undefined,
        windowsHide: true
      });

      processHandle.stdout.on("data", (chunk) => appendLog(chunk.toString()));
      processHandle.stderr.on("data", (chunk) => appendLog(chunk.toString()));
      processHandle.on("error", (error) => appendLog(error.message));
      processHandle.on("exit", (code) => appendLog(`Open WebUI process exited with code ${code ?? "unknown"}.`));

      return { started: true, message: "Open WebUI startup has been requested." };
    }
  };
}

function createInitialManagedServerSetupStatus(clock: Clock): ManagedServerSetupStatus {
  return {
    state: "idle",
    phase: "idle",
    progress: 0,
    message: "The server has not been prepared yet.",
    ollamaReady: false,
    chatReady: false,
    adminReady: false,
    updatedAt: clock.now().toISOString()
  };
}

async function runManagedServerSetup(input: {
  admin: { email: string; name: string; password: string };
  clock: Clock;
  fetchImpl: typeof fetch;
  getOllamaHealth(): Promise<ComponentHealth>;
  localEnvPath?: string;
  openWebUIRuntime: OpenWebUIRuntimeController;
  update(next: Partial<ManagedServerSetupStatus>): void;
}): Promise<{ apiKey: string; baseUrl: string }> {
  const baseUrl = "http://127.0.0.1:8080";

  input.update({ phase: "checking", progress: 8, message: "Checking Ollama and the local chat runtime." });
  const ollamaReady = await ensureOllamaIsReady(input.getOllamaHealth, (phase, progress, message) => {
    input.update({ phase, progress, message });
  });

  if (!ollamaReady) {
    throw new Error("Ollama could not be installed or started automatically. Open the system installer and try again.");
  }

  input.update({ ollamaReady: true, phase: "installing_chat", progress: 48, message: "Preparing the administrator chat." });
  const preparedRuntimeAvailable =
    (await input.openWebUIRuntime.prepareManagedRuntime?.((runtimeProgress) => {
      input.update({
        phase: "installing_chat",
        progress: 48 + Math.round(((runtimeProgress.percent ?? 0) / 100) * 14),
        message: runtimeProgress.message
      });
    })) ?? false;

  if (!preparedRuntimeAvailable) {
    input.update({ phase: "installing_chat", progress: 50, message: "Preparing the compatible chat installer." });
    await ensureUvIsAvailable(input.openWebUIRuntime);
  }

  const usesIntelMacRuntime = platform() === "darwin" && arch() === "x64";
  input.update({
    phase: "starting_chat",
    progress: 64,
    message: usesIntelMacRuntime
      ? "Intel Mac detected. Starting the compatible local chat runtime."
      : "Starting the local chat for the first time."
  });
  const startResult = await input.openWebUIRuntime.start({
    dataDir: input.openWebUIRuntime.getDataDir(),
    port: 8080
  });

  if (!startResult.started) {
    throw new Error(startResult.message);
  }

  let chatReady: boolean;

  try {
    chatReady = await waitForManagedChat({
      clock: input.clock,
      fetchImpl: input.fetchImpl,
      getRuntimeLog: input.openWebUIRuntime.getLog,
      isRuntimeAlive: input.openWebUIRuntime.isStartedByModelDock,
      update: input.update,
      url: baseUrl
    });
  } catch {
    input.update({
      phase: "starting_chat",
      progress: 68,
      message: "The prepared chat start failed. Retrying with the compatible installer."
    });
    const fallbackResult = await input.openWebUIRuntime.start({
      compatibilityMode: true,
      dataDir: input.openWebUIRuntime.getDataDir(),
      port: 8080
    });

    if (!fallbackResult.started) {
      throw new Error(fallbackResult.message);
    }

    chatReady = await waitForManagedChat({
      clock: input.clock,
      fetchImpl: input.fetchImpl,
      getRuntimeLog: input.openWebUIRuntime.getLog,
      isRuntimeAlive: input.openWebUIRuntime.isStartedByModelDock,
      update: input.update,
      url: baseUrl
    });
  }

  if (!chatReady) {
    throw new Error("The chat was started but did not become ready in time. ModelDock can retry without downloading it again.");
  }

  input.update({ chatReady: true, phase: "configuring_admin", progress: 86, message: "Creating and securing the administrator connection." });
  const apiKey = await provisionOpenWebUIAdmin({
    admin: input.admin,
    baseUrl,
    fetchImpl: input.fetchImpl
  });

  await upsertLocalEnvValues(
    {
      MODELDOCK_OPENWEBUI_API_KEY: apiKey,
      MODELDOCK_OPENWEBUI_BASE_URL: baseUrl
    },
    input.localEnvPath
  );

  return { apiKey, baseUrl };
}

async function ensureOllamaIsReady(
  getHealth: () => Promise<ComponentHealth>,
  update: (phase: ManagedServerSetupStatus["phase"], progress: number, message: string) => void
): Promise<boolean> {
  if ((await getHealth()).status === "available") {
    return true;
  }

  let executable = await findAvailableCommand(resolveOllamaCommandCandidates());

  if (!executable) {
    update("installing_ollama", 18, "Downloading the local model engine.");
    const installResult = await installOllamaForCurrentPlatform();

    if (!installResult.ok) {
      return false;
    }

    executable = await findAvailableCommand(resolveOllamaCommandCandidates());
  }

  if (!executable) {
    return false;
  }

  update("starting_ollama", 34, "Starting the local model engine.");
  const child = spawn(executable, ["serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
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

  return [
    "ollama",
    "/Applications/Ollama.app/Contents/Resources/ollama",
    "/opt/homebrew/bin/ollama",
    "/usr/local/bin/ollama"
  ];
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

async function ensureUvIsAvailable(runtime: OpenWebUIRuntimeController): Promise<void> {
  if (await runtime.isUvAvailable()) {
    return;
  }

  const result = platform() === "win32"
    ? await runCommand(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"],
        5 * 60_000
      )
    : await runCommand("sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"], 5 * 60_000);

  if (!result.ok || !(await runtime.isUvAvailable())) {
    throw new Error("The chat installer could not be prepared automatically.");
  }
}

async function provisionOpenWebUIAdmin(input: {
  admin: { email: string; name: string; password: string };
  baseUrl: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  let authenticationResponse = await input.fetchImpl(`${input.baseUrl}/api/v1/auths/signin`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: input.admin.email, password: input.admin.password }),
    signal: AbortSignal.timeout(10_000)
  });

  if (!authenticationResponse.ok) {
    authenticationResponse = await input.fetchImpl(`${input.baseUrl}/api/v1/auths/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        email: input.admin.email,
        name: input.admin.name,
        password: input.admin.password,
        profile_image_url: "/user.png"
      }),
      signal: AbortSignal.timeout(10_000)
    });
  }

  if (!authenticationResponse.ok) {
    throw new Error("The chat is ready, but the administrator account could not be created or verified. If this is an existing ModelDock installation, use its current administrator credentials.");
  }

  const session = (await authenticationResponse.json()) as { role?: string; token?: string };

  if (!session.token || session.role !== "admin") {
    throw new Error("The configured chat account is not an administrator.");
  }

  const apiKeyResponse = await input.fetchImpl(`${input.baseUrl}/api/v1/auths/api_key`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: "{}",
    signal: AbortSignal.timeout(10_000)
  });

  if (!apiKeyResponse.ok) {
    return session.token;
  }

  const result = (await apiKeyResponse.json()) as { api_key?: string };
  return result.api_key?.trim() || session.token;
}

async function waitForHealth(
  getHealth: () => Promise<ComponentHealth>,
  attempts: number,
  intervalMs: number
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await getHealth()).status === "available") {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}

async function waitForManagedChat(input: {
  clock: Clock;
  fetchImpl: typeof fetch;
  getRuntimeLog(): string[];
  isRuntimeAlive(): boolean;
  update(next: Partial<ManagedServerSetupStatus>): void;
  url: string;
}): Promise<boolean> {
  const attempts = 240;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await getOpenWebUIHealth(input.url, input.clock, input.fetchImpl)).status === "available") {
      return true;
    }

    if (attempt > 2 && !input.isRuntimeAlive()) {
      const diagnostic = summarizeOpenWebUIRuntimeFailure(input.getRuntimeLog());
      throw new Error(
        diagnostic
          ? `La chat si è arrestata durante l'avvio. Dettaglio: ${diagnostic}`
          : "La chat si è arrestata durante l'avvio senza restituire un dettaglio tecnico."
      );
    }

    const elapsedSeconds = attempt * 2;
    const progress = Math.min(83, 64 + Math.floor(attempt / 5));
    const message = elapsedSeconds < 30
      ? "Downloading the chat components for the first start."
      : elapsedSeconds < 120
        ? "Installing the local chat. The first start can take a few minutes."
        : "Finishing the first local chat start. ModelDock is still working.";

    input.update({ phase: "starting_chat", progress, message });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return false;
}

export function summarizeOpenWebUIRuntimeFailure(log: string[]): string | undefined {
  const lines = log
    .flatMap((entry) => entry.split(/\r?\n/))
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
  const informativeLines = lines.filter((line) => !/^Open WebUI process exited with code /i.test(line));
  const selectedLines = (informativeLines.length > 0 ? informativeLines : lines).slice(-4);
  const summary = selectedLines.join(" — ");

  return summary ? summary.slice(-1200) : undefined;
}

async function startTailscaleLoginForCurrentPlatform(): Promise<{ message: string; started: boolean }> {
  if (platform() === "darwin" && existsSync("/Applications/Tailscale.app")) {
    try {
      const child = spawn("open", ["-a", "Tailscale"], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();

      return {
        started: true,
        message: "Tailscale is open. Start a fresh sign-in from the app and use the new browser tab."
      };
    } catch (error) {
      return {
        started: false,
        message: error instanceof Error ? error.message : "Tailscale could not be opened."
      };
    }
  }

  const command = await findAvailableCommand(resolveTailscaleCommandCandidatesForSetup());

  if (!command) {
    return { started: false, message: "Tailscale is not installed on this computer." };
  }

  try {
    const child = spawn(command, ["login"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();

    return { started: true, message: "A fresh Tailscale sign-in has been opened." };
  } catch (error) {
    return {
      started: false,
      message: error instanceof Error ? error.message : "Tailscale sign-in could not be opened."
    };
  }
}

function resolveTailscaleCommandCandidatesForSetup(): string[] {
  if (platform() === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return ["tailscale.exe", "tailscale", join(programFiles, "Tailscale", "tailscale.exe")];
  }

  return ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"];
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }

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

function resolveOpenWebUIDataDir(): string {
  if (platform() === "win32") {
    return join(homedir(), "AppData", "Local", "ModelDock", "open-webui");
  }

  return join(homedir(), ".modeldock", "open-webui");
}

export function resolveUvCommandCandidates(platformId: NodeJS.Platform = platform(), homeDirectory: string = homedir()): string[] {
  return resolvePythonToolCommandCandidates("uv", platformId, homeDirectory);
}

export function resolveUvxCommandCandidates(platformId: NodeJS.Platform = platform(), homeDirectory: string = homedir()): string[] {
  return resolvePythonToolCommandCandidates("uvx", platformId, homeDirectory);
}

function resolvePythonToolCommandCandidates(commandName: "uv" | "uvx", platformId: NodeJS.Platform, homeDirectory: string): string[] {
  if (platformId === "win32") {
    return [
      `${commandName}.exe`,
      `${commandName}.cmd`,
      commandName,
      join(homeDirectory, ".local", "bin", `${commandName}.exe`),
      join(homeDirectory, ".local", "bin", `${commandName}.cmd`)
    ];
  }

  const homeLocalBinCommand = posix.join(homeDirectory, ".local", "bin", commandName);
  const candidates = [commandName, homeLocalBinCommand, "/usr/local/bin/" + commandName];

  if (platformId === "darwin") {
    candidates.push("/opt/homebrew/bin/" + commandName);
  }

  return candidates;
}

async function findAvailableCommand(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const result = await runFirstAvailableCommand([candidate], ["--version"], 2500);

    if (result.ok) {
      return candidate;
    }
  }

  return undefined;
}

async function runFirstAvailableCommand(candidates: string[], args: string[], timeoutMs: number): Promise<{ ok: boolean }> {
  for (const candidate of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(candidate, args, { windowsHide: true });
      const timeout = setTimeout(() => {
        child.kill();
        resolve(false);
      }, timeoutMs);

      child.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        resolve(code === 0);
      });
    });

    if (ok) {
      return { ok: true };
    }
  }

  return { ok: false };
}

async function upsertLocalEnvValues(values: Record<string, string>, envPath = join(process.cwd(), ".env")): Promise<void> {
  const current = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
  const lines = current ? current.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values));
  const nextLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)=/);
    const key = match?.[1];

    if (!key || !pending.has(key)) {
      return line;
    }

    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of pending) {
    nextLines.push(`${key}=${value}`);
  }

  const nextContent = `${nextLines.join("\n").replace(/\n*$/, "")}\n`;
  await writeFile(envPath, nextContent, "utf8");
}

async function syncModelPoliciesWithRuntimeState(dependencies: RuntimeDependencies, models: Model[]) {
  await Promise.all(
    models.map(async (model) => {
      await dependencies.modelAccess.ensurePolicy(model.name);
      await dependencies.modelAccess.updatePolicy({
        modelName: model.name,
        loaded: model.running
      });
    })
  );
}

async function runModelPullJob(
  dependencies: RuntimeDependencies,
  jobs: Map<string, ModelPullJob>,
  jobId: string,
  correlationId: string
) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  updatePullJob(dependencies, jobs, jobId, {
    status: "running",
    message: "Starting download"
  });

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

    updatePullJob(dependencies, jobs, jobId, {
      status: "succeeded",
      message: "Pull completed"
    });

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

  if (!current) {
    return;
  }

  jobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: dependencies.clock.now().toISOString()
  });
}
