import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  buildApp,
  resolveManagedOpenWebUIRuntimeProfile,
  resolveOpenWebUILocalInstall,
  resolveUvxCommandCandidates,
  summarizeOpenWebUIRuntimeFailure
} from "./app.ts";

describe("Open WebUI runtime diagnostics", () => {
  it("keeps the useful error instead of only the exit code", () => {
    expect(
      summarizeOpenWebUIRuntimeFailure([
        "Downloading packages",
        "error: failed to build a required dependency",
        "Open WebUI process exited with code 1."
      ])
    ).toContain("failed to build a required dependency");
  });

  it("selects the last runtime with official Intel Mac wheels before starting Open WebUI", () => {
    expect(resolveManagedOpenWebUIRuntimeProfile("darwin", "x64")).toEqual({
      extraPackages: ["greenlet", "itsdangerous", "beautifulsoup4", "cryptography==48.0.1"],
      packageSpec: "open-webui@0.7.2",
      profile: "intel-mac"
    });
  });

  it("keeps the current Open WebUI runtime on Apple Silicon", () => {
    expect(resolveManagedOpenWebUIRuntimeProfile("darwin", "arm64")).toEqual({
      extraPackages: [],
      packageSpec: "open-webui@latest",
      profile: "current"
    });
  });

  it("includes the native Windows runtime dependency", () => {
    expect(resolveManagedOpenWebUIRuntimeProfile("win32", "x64").extraPackages).toEqual(["pywin32"]);
  });
});

describe("ModelDock API", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns health", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "modeldock-api" });
  });

  it("returns aggregated system status", async () => {
    const response = await app.inject({ method: "GET", url: "/api/system/status" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.overall).toBe("ok");
    expect(body.components.ollama.status).toBe("available");
    expect(body.components.openWebUI.status).toBe("not_configured");
  });

  it("returns Ollama integration status", async () => {
    const response = await app.inject({ method: "GET", url: "/api/integrations/ollama/status" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      name: "ollama",
      status: "available"
    });
  });

  it("returns Ollama setup status with the configured models path", async () => {
    const configuredPath = "D:\\ModelDock\\ollama-models";
    const setupApp = await buildApp({ ollamaModelsPath: configuredPath });

    try {
      const response = await setupApp.inject({ method: "GET", url: "/api/setup/ollama" });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body.health).toMatchObject({ name: "ollama", status: "available" });
      expect(body.modelsPath).toBe(configuredPath);
      expect(body.pathSource).toBe("modeldock_env");
      expect(body.modelCount).toBeGreaterThan(0);
      expect(body.apiExposesModelsPath).toBe(false);
    } finally {
      await setupApp.close();
    }
  });

  it("prepares a managed local server without persisting the administrator password", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "modeldock-managed-setup-"));
    const envPath = join(tempDirectory, ".env");
    const setupApp = await buildApp({
      localEnvPath: envPath,
      openWebUIFetch: async (url, init) => {
        const path = String(url);

        if (path.endsWith("/api/v1/auths/signin")) {
          return Response.json({ role: "admin", token: "jwt-admin-token" });
        }

        if (path.endsWith("/api/v1/auths/api_key") && init?.method === "POST") {
          return Response.json({ api_key: "sk-managed-admin" });
        }

        return new Response("ok", { status: 200 });
      },
      openWebUIRuntime: {
        getDataDir: () => join(tempDirectory, "open-webui"),
        getLog: () => [],
        isStartedByModelDock: () => true,
        isUvAvailable: async () => true,
        start: async () => ({ started: true, message: "started" })
      }
    });

    try {
      const response = await setupApp.inject({
        method: "POST",
        url: "/api/setup/server",
        payload: {
          adminEmail: "admin@example.com",
          adminName: "Admin",
          adminPassword: "a-secure-password"
        }
      });

      expect(response.statusCode).toBe(202);

      let status = (await setupApp.inject({ method: "GET", url: "/api/setup/server" })).json();

      for (let attempt = 0; attempt < 20 && status.state === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = (await setupApp.inject({ method: "GET", url: "/api/setup/server" })).json();
      }

      expect(status).toMatchObject({
        state: "succeeded",
        phase: "ready",
        progress: 100,
        ollamaReady: true,
        chatReady: true,
        adminReady: true,
        chatUrl: "http://127.0.0.1:8080"
      });

      const envFile = await readFile(envPath, "utf8");
      expect(envFile).toContain("MODELDOCK_OPENWEBUI_API_KEY=sk-managed-admin");
      expect(envFile).not.toContain("a-secure-password");
    } finally {
      await setupApp.close();
      await rm(tempDirectory, { force: true, recursive: true });
    }
  });

  it("returns Tailscale setup status from the local runtime boundary", async () => {
    const response = await app.inject({ method: "GET", url: "/api/setup/tailscale" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.health).toMatchObject({ name: "tailscale", status: "available" });
    expect(body.installed).toBe(true);
    expect(body.loggedIn).toBe(true);
    expect(body.addresses).toEqual(expect.arrayContaining(["100.64.0.10"]));
    expect(body.suggestedServerUrl).toBe("http://100.64.0.10:4173");
  });

  it("returns Open WebUI integration status", async () => {
    const response = await app.inject({ method: "GET", url: "/api/integrations/open-webui/status" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      name: "open-webui",
      status: "not_configured"
    });
  });

  it("returns Open WebUI setup status when the URL is reachable but admin API key is missing", async () => {
    const setupApp = await buildApp({
      openWebUIBaseUrl: "http://openwebui.local",
      openWebUIFetch: async () => new Response("ok", { status: 200 })
    });

    try {
      const response = await setupApp.inject({ method: "GET", url: "/api/setup/open-webui" });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body).toMatchObject({
        baseUrl: "http://openwebui.local",
        reachable: true,
        apiKeyConfigured: false,
        adminVerified: false
      });
    } finally {
      await setupApp.close();
    }
  });

  it("returns Open WebUI runtime status for an already running instance", async () => {
    const setupApp = await buildApp({
      openWebUIFetch: async () => new Response("ok", { status: 200 }),
      openWebUIRuntime: {
        getDataDir: () => "C:\\ModelDock\\open-webui",
        getLog: () => [],
        isStartedByModelDock: () => false,
        isUvAvailable: async () => true,
        start: async () => ({ started: true, message: "started" })
      }
    });

    try {
      const response = await setupApp.inject({
        method: "GET",
        url: "/api/setup/open-webui/runtime?baseUrl=http%3A%2F%2F127.0.0.1%3A8080"
      });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body).toMatchObject({
        baseUrl: "http://127.0.0.1:8080",
        dataDir: "C:\\ModelDock\\open-webui",
        port: 8080,
        uvAvailable: true,
        running: true,
        state: "running"
      });
    } finally {
      await setupApp.close();
    }
  });

  it("detects an existing local Open WebUI virtual environment", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "modeldock-openwebui-install-"));
    const scriptsDirectory = join(tempDirectory, "venv", "Scripts");
    const executablePath = join(scriptsDirectory, "open-webui.exe");
    await mkdir(scriptsDirectory, { recursive: true });
    await writeFile(executablePath, "", "utf8");

    const setupApp = await buildApp({
      openWebUIFetch: async () => new Response("not ready", { status: 503 }),
      openWebUIRuntime: {
        getDataDir: () => "C:\\ModelDock\\open-webui",
        getLog: () => [],
        isStartedByModelDock: () => false,
        isUvAvailable: async () => true,
        start: async () => ({ started: true, message: "started" })
      }
    });

    try {
      const response = await setupApp.inject({
        method: "GET",
        url: `/api/setup/open-webui/runtime?baseUrl=http%3A%2F%2F127.0.0.1%3A8080&installPath=${encodeURIComponent(tempDirectory)}`
      });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body).toMatchObject({
        executablePath,
        installPath: tempDirectory,
        installed: true,
        running: false,
        state: "not_running"
      });
    } finally {
      await setupApp.close();
      await rm(tempDirectory, { force: true, recursive: true });
    }
  });

  it("detects an existing local Open WebUI virtual environment on macOS-style installs", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "modeldock-openwebui-macos-install-"));
    const binDirectory = join(tempDirectory, ".venv", "bin");
    const executablePath = join(binDirectory, "open-webui");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(executablePath, "", "utf8");

    try {
      const install = resolveOpenWebUILocalInstall(tempDirectory, "darwin");

      expect(install).toMatchObject({
        executablePath,
        installPath: tempDirectory,
        installed: true
      });
    } finally {
      await rm(tempDirectory, { force: true, recursive: true });
    }
  });

  it("checks common macOS uvx install locations", () => {
    const candidates = resolveUvxCommandCandidates("darwin", "/Users/simone");

    expect(candidates).toEqual(
      expect.arrayContaining(["uvx", "/Users/simone/.local/bin/uvx", "/usr/local/bin/uvx", "/opt/homebrew/bin/uvx"])
    );
  });

  it("requests Open WebUI startup through the runtime controller", async () => {
    let started = false;
    let requestedPort = 0;
    const setupApp = await buildApp({
      openWebUIFetch: async () => new Response("not ready", { status: 503 }),
      openWebUIRuntime: {
        getDataDir: () => "C:\\ModelDock\\open-webui",
        getLog: () => (started ? ["Starting Open WebUI from ModelDock."] : []),
        isStartedByModelDock: () => started,
        isUvAvailable: async () => true,
        start: async (input) => {
          started = true;
          requestedPort = input.port;
          return { started: true, message: "startup requested" };
        }
      }
    });

    try {
      const response = await setupApp.inject({
        method: "POST",
        url: "/api/setup/open-webui/start",
        payload: {
          baseUrl: "http://127.0.0.1:8080"
        }
      });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(started).toBe(true);
      expect(requestedPort).toBe(8080);
      expect(body).toMatchObject({
        running: false,
        startedByModelDock: true,
        state: "starting",
        log: ["Starting Open WebUI from ModelDock."]
      });
    } finally {
      await setupApp.close();
    }
  });

  it("verifies Open WebUI admin API access", async () => {
    const requestedUrls: string[] = [];
    const setupApp = await buildApp({
      openWebUIApiKey: "sk-openwebui-test",
      openWebUIBaseUrl: "http://openwebui.local",
      openWebUIFetch: async (url, init) => {
        requestedUrls.push(String(url));

        if (String(url).endsWith("/api/v1/auths/")) {
          expect(init?.headers).toMatchObject({ authorization: "Bearer sk-openwebui-test" });
          return jsonResponse({
            id: "admin-1",
            email: "admin@example.test",
            name: "Admin",
            role: "admin"
          });
        }

        if (String(url).endsWith("/api/models")) {
          return jsonResponse([{ id: "phi3:3.8b" }, { id: "tinyllama:latest" }]);
        }

        return new Response("ok", { status: 200 });
      }
    });

    try {
      const response = await setupApp.inject({ method: "GET", url: "/api/setup/open-webui" });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body).toMatchObject({
        apiKeyConfigured: true,
        adminVerified: true,
        modelCount: 2,
        authenticatedUser: {
          email: "admin@example.test",
          role: "admin"
        }
      });
      expect(requestedUrls).toEqual([
        "http://openwebui.local",
        "http://openwebui.local/api/v1/auths/",
        "http://openwebui.local/api/models"
      ]);
    } finally {
      await setupApp.close();
    }
  });

  it("saves the Open WebUI admin API key to the configured env file and verifies it", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "modeldock-openwebui-"));
    const localEnvPath = join(tempDirectory, ".env");
    const setupApp = await buildApp({
      localEnvPath,
      openWebUIFetch: async (url, init) => {
        if (String(url).endsWith("/api/v1/auths/")) {
          expect(init?.headers).toMatchObject({ authorization: "Bearer sk-openwebui-test" });
          return jsonResponse({
            id: "admin-1",
            email: "admin@example.test",
            name: "Admin",
            role: "admin"
          });
        }

        if (String(url).endsWith("/api/models")) {
          return jsonResponse([{ id: "phi3:3.8b" }]);
        }

        return new Response("ok", { status: 200 });
      }
    });

    try {
      const response = await setupApp.inject({
        method: "POST",
        url: "/api/setup/open-webui/api-key",
        payload: {
          apiKey: "sk-openwebui-test",
          baseUrl: "http://openwebui.local"
        }
      });
      const body = response.json();
      const envFile = await readFile(localEnvPath, "utf8");

      expect(response.statusCode).toBe(200);
      expect(body).toMatchObject({
        adminVerified: true,
        apiKeyConfigured: true,
        baseUrl: "http://openwebui.local",
        modelCount: 1
      });
      expect(envFile).toContain("MODELDOCK_OPENWEBUI_BASE_URL=http://openwebui.local");
      expect(envFile).toContain("MODELDOCK_OPENWEBUI_API_KEY=sk-openwebui-test");
    } finally {
      await setupApp.close();
      await rm(tempDirectory, { force: true, recursive: true });
    }
  });

  it("runs diagnostics", async () => {
    const response = await app.inject({ method: "POST", url: "/api/diagnostics/run-all" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns local resource metrics", async () => {
    const response = await app.inject({ method: "GET", url: "/api/system/resources" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.memory.totalBytes).toBeGreaterThan(0);
    expect(body.inferenceProjection.tokensPerSecond.min).toBeGreaterThan(0);
  });

  it("returns model access policies", async () => {
    const response = await app.inject({ method: "GET", url: "/api/access/model-policies" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.groups.map((group: { name: string }) => group.name)).toContain("Builders");
    expect(body.models[0]).toMatchObject({ modelName: "llama3.1:8b", enabled: true, loaded: true });
  });

  it("updates model access policies and emits audit", async () => {
    const updateResponse = await app.inject({
      method: "PUT",
      url: "/api/access/model-policies",
      payload: {
        modelName: "phi3:mini",
        enabled: false,
        groupGrants: {
          "grp-guests": false
        }
      }
    });
    const updatedPolicy = updateResponse.json();

    expect(updateResponse.statusCode).toBe(200);
    expect(updatedPolicy.enabled).toBe(false);
    expect(updatedPolicy.grants.some((grant: { subject: { id: string } }) => grant.subject.id === "grp-guests")).toBe(false);

    const auditResponse = await app.inject({ method: "GET", url: "/api/audit/events" });
    expect(auditResponse.json()[0]).toMatchObject({
      action: "MODEL_ACCESS_POLICY_UPDATED",
      module: "access-control",
      resourceId: "phi3:mini"
    });
  });

  it("loads and unloads models through the Ollama runtime boundary", async () => {
    const loadResponse = await app.inject({
      method: "PUT",
      url: "/api/access/model-policies",
      payload: {
        modelName: "phi3:mini",
        loaded: true
      }
    });

    expect(loadResponse.statusCode).toBe(200);
    expect(loadResponse.json()).toMatchObject({ modelName: "phi3:mini", loaded: true });

    const modelsAfterLoad = (await app.inject({ method: "GET", url: "/api/models" })).json();
    expect(modelsAfterLoad.find((model: { name: string }) => model.name === "phi3:mini")).toMatchObject({ running: true });

    const unloadResponse = await app.inject({
      method: "PUT",
      url: "/api/access/model-policies",
      payload: {
        modelName: "phi3:mini",
        loaded: false
      }
    });

    expect(unloadResponse.statusCode).toBe(200);
    expect(unloadResponse.json()).toMatchObject({ modelName: "phi3:mini", loaded: false });

    const modelsAfterUnload = (await app.inject({ method: "GET", url: "/api/models" })).json();
    expect(modelsAfterUnload.find((model: { name: string }) => model.name === "phi3:mini")).toMatchObject({ running: false });
  });

  it("pulls and deletes models with matching access policies and audit", async () => {
    const modelName = "mistral:7b";
    const pullResponse = await app.inject({
      method: "POST",
      url: "/api/models/pull",
      payload: {
        name: modelName
      }
    });

    expect(pullResponse.statusCode).toBe(202);
    const pullJob = pullResponse.json();
    expect(pullJob).toMatchObject({ model: modelName, status: "queued" });

    const completedPullJob = await waitForPullJob(app, pullJob.id);
    expect(completedPullJob).toMatchObject({ model: modelName, status: "succeeded" });

    const modelsAfterPull = (await app.inject({ method: "GET", url: "/api/models" })).json();
    expect(modelsAfterPull.map((model: { name: string }) => model.name)).toContain(modelName);

    const accessAfterPull = (await app.inject({ method: "GET", url: "/api/access/model-policies" })).json();
    expect(accessAfterPull.models).toContainEqual(
      expect.objectContaining({
        modelName,
        enabled: true,
        loaded: false
      })
    );

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/models/${encodeURIComponent(modelName)}`
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ deleted: true });

    const modelsAfterDelete = (await app.inject({ method: "GET", url: "/api/models" })).json();
    expect(modelsAfterDelete.map((model: { name: string }) => model.name)).not.toContain(modelName);

    const accessAfterDelete = (await app.inject({ method: "GET", url: "/api/access/model-policies" })).json();
    expect(accessAfterDelete.models.map((policy: { modelName: string }) => policy.modelName)).not.toContain(modelName);

    const auditResponse = await app.inject({ method: "GET", url: "/api/audit/events" });
    expect(auditResponse.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "MODEL_PULL_SUCCEEDED", module: "models", resourceId: modelName }),
        expect.objectContaining({ action: "MODEL_DELETE_SUCCEEDED", module: "models", resourceId: modelName })
      ])
    );
  });

  it("returns a not found error for unknown pull jobs", async () => {
    const response = await app.inject({ method: "GET", url: "/api/models/pull-jobs/missing" });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: "MODEL_PULL_JOB_NOT_FOUND"
    });
  });

  it("returns tailnet devices with authorization state", async () => {
    const response = await app.inject({ method: "GET", url: "/api/network/tailscale/devices" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body[0]).toMatchObject({
      id: "node_local",
      hostname: "modeldock-node",
      authorized: true
    });
  });

  it("updates tailnet device authorization and emits audit", async () => {
    const updateResponse = await app.inject({
      method: "PUT",
      url: "/api/network/tailscale/devices/phone_1",
      payload: {
        authorized: true
      }
    });
    const updatedDevice = updateResponse.json();

    expect(updateResponse.statusCode).toBe(200);
    expect(updatedDevice).toMatchObject({
      id: "phone_1",
      authorized: true
    });

    const auditResponse = await app.inject({ method: "GET", url: "/api/audit/events" });
    expect(auditResponse.json()[0]).toMatchObject({
      action: "TAILSCALE_DEVICE_AUTHORIZATION_UPDATED",
      module: "network",
      resourceId: "phone_1"
    });
  });
});

async function waitForPullJob(app: FastifyInstance, jobId: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/models/pull-jobs/${jobId}` });
    const job = response.json();

    if (job.status === "succeeded" || job.status === "failed") {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Pull job ${jobId} did not finish`);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json"
    },
    status: 200
  });
}
