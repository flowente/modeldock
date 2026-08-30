import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.ts";

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

  it("returns Open WebUI integration status", async () => {
    const response = await app.inject({ method: "GET", url: "/api/integrations/open-webui/status" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      name: "open-webui",
      status: "not_configured"
    });
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
