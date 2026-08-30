import { freemem, totalmem } from "node:os";
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
  type OllamaGateway,
  type SystemResources,
  type TailscaleGateway
} from "@modeldock/core";
import { createDiagnosticRegistry } from "@modeldock/diagnostics";
import { OllamaHttpGateway } from "@modeldock/ollama-adapter";
import { TailscaleApiGateway, TailscaleCliGateway } from "@modeldock/tailscale-adapter";
import { createFakeDependencies } from "@modeldock/testing";

export type OllamaRuntimeMode = "fake" | "real" | "auto";
export type TailscaleRuntimeMode = "fake" | "real" | "cli" | "api" | "auto";

export interface BuildAppOptions {
  logger?: boolean;
  ollamaBaseUrl?: string;
  ollamaMode?: OllamaRuntimeMode;
  openWebUIBaseUrl?: string;
  tailscaleApiBaseUrl?: string;
  tailscaleApiToken?: string;
  tailscaleMode?: TailscaleRuntimeMode;
  tailscaleTailnet?: string;
}

interface RuntimeDependencies {
  clock: Clock;
  ids: IdGenerator;
  auditStore: AuditStore;
  modelAccess: ModelAccessStore;
  ollama: OllamaGateway;
  tailscale: TailscaleGateway;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const dependencies = createRuntimeDependencies(options);
  const diagnostics = createDiagnosticRegistry(dependencies);
  const modelPullJobs = new Map<string, ModelPullJob>();
  const app = Fastify({ logger: options.logger ?? false });

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
      getOpenWebUIHealth(options.openWebUIBaseUrl, dependencies.clock)
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
  app.get("/api/integrations/open-webui/status", async () => getOpenWebUIHealth(options.openWebUIBaseUrl, dependencies.clock));

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
    return dependencies;
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
    })
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

async function getOpenWebUIHealth(baseUrl: string | undefined, clock: Clock): Promise<ComponentHealth> {
  const normalizedBaseUrl = baseUrl?.trim().replace(/\/$/, "");

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
    const response = await fetch(normalizedBaseUrl, {
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
