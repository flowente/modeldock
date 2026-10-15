import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { joinWithLink, pinnedRequest, TOKEN_HEADER } from "@modeldock/link";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";

const admin = { email: "simone@example.com", displayName: "Simone", password: "una-password-lunga" };
const apps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function start(options: Parameters<typeof buildApp>[0] = {}) {
  const app = await buildApp({ ollamaMode: "fake", ...options });
  apps.push(app);
  return app;
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "modeldock-app-"));
  directories.push(directory);
  return directory;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function cookieFrom(response: LightMyRequestResponse): string {
  return String(response.headers["set-cookie"] ?? "").split(";")[0] ?? "";
}

describe("ModelDock API", () => {
  it("reports its health", async () => {
    const app = await start();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.json()).toMatchObject({ status: "ok", service: "modeldock-api" });
  });

  it("status: Ollama and storage, and a device connection that is off when not configured", async () => {
    const app = await start();
    const body = (await app.inject({ method: "GET", url: "/api/system/status" })).json();
    expect(Object.keys(body.components).sort()).toEqual(["backend", "link", "ollama", "storage"]);
    expect(body.components.link.status).toBe("not_configured");
    expect(body.components.ollama.status).toBe("available");
    // No more Open WebUI or Tailscale in the picture.
    expect(JSON.stringify(body)).not.toMatch(/openWebUI|tailscale/i);
  });

  it("resources: only what is measured, no invented speeds", async () => {
    const app = await start();
    const body = (await app.inject({ method: "GET", url: "/api/system/resources" })).json();
    expect(body.memory.totalBytes).toBeGreaterThan(0);
    expect(body.cpu.cores).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("inferenceProjection");
    expect(body).not.toHaveProperty("gpu");
  });

  it("power: Ollama on, then releasing memory unloads every model", async () => {
    const app = await start();
    const on = (await app.inject({ method: "GET", url: "/api/server/power" })).json();
    expect(on).toMatchObject({ state: "on", ollamaReady: true });
    expect(on.loadedModels).toBeGreaterThan(0);

    const released = (await app.inject({ method: "POST", url: "/api/server/release-memory" })).json();
    expect(released.loadedModels).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/models/running" })).json()).toEqual([]);
  });

  it("models: list, download job, delete", async () => {
    const app = await start();
    const models = (await app.inject({ method: "GET", url: "/api/models" })).json();
    expect(models.map((model: { name: string }) => model.name)).toContain("phi3:mini");

    const pull = await app.inject({ method: "POST", url: "/api/models/pull", payload: { name: "gemma3:4b" } });
    expect(pull.statusCode).toBe(202);
    await expect
      .poll(async () => (await app.inject({ method: "GET", url: `/api/models/pull-jobs/${pull.json().id}` })).json().status)
      .toBe("succeeded");

    expect((await app.inject({ method: "DELETE", url: "/api/models/phi3:mini" })).json()).toEqual({ deleted: true });
    expect((await app.inject({ method: "GET", url: "/api/models/pull-jobs/inesistente" })).statusCode).toBe(404);
  });

  it("access policies can switch a model off", async () => {
    const app = await start();
    const policy = (await app.inject({ method: "PUT", url: "/api/access/model-policies", payload: { modelName: "phi3:mini", enabled: false } })).json();
    expect(policy).toMatchObject({ modelName: "phi3:mini", enabled: false });
  });

  it("diagnostics run and are logged", async () => {
    const app = await start();
    const checks = (await app.inject({ method: "GET", url: "/api/diagnostics/checks" })).json();
    expect(checks.map((check: { id: string }) => check.id)).toEqual(["backend.health", "storage.audit", "ollama.connection", "ollama.listModels"]);
    const results = (await app.inject({ method: "POST", url: "/api/diagnostics/run-all" })).json();
    expect(results.every((result: { status: string }) => result.status === "pass")).toBe(true);
    expect(JSON.stringify((await app.inject({ method: "GET", url: "/api/audit/events" })).json())).toContain("DIAGNOSTIC_RUN_ALL");
  });

  it("serves the built chat at / and never lets the page be cached", async () => {
    const webRoot = await tempDir();
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>ModelDock</title>");
    const app = await start({ webRoot });
    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("ModelDock");
    expect(page.headers["cache-control"]).toBe("no-cache");
    // The API is still the API.
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("errors keep their status when the chat is served too (the production setup)", async () => {
    const webRoot = await tempDir();
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>ModelDock</title>");
    const app = await start({ webRoot, requireLogin: true });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "nessuno@example.com", password: "sbagliata-123" } });
    expect(login.statusCode).toBe(401);
    expect(login.json().error.code).toBe("ACCOUNT_LOGIN_FAILED");
    expect((await app.inject({ method: "GET", url: "/api/models/pull-jobs/x" })).statusCode).toBe(401);
  });

  it("without a built chat the API starts anyway", async () => {
    const app = await start({ webRoot: await tempDir() });
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });
});

describe("device connection", () => {
  async function startWithLink(allowUnpairedBrowsers = false) {
    const port = await freePort();
    const app = await start({
      requireLogin: true,
      link: { port: 0, dataDir: await tempDir(), upstreamPort: port, allowUnpairedBrowsers, listenHost: "127.0.0.1" }
    });
    await app.listen({ host: "127.0.0.1", port });
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: admin });
    return { app, cookie: cookieFrom(setup) };
  }

  it("device routes are for administrators; without the connection they say it is off", async () => {
    const app = await start({ requireLogin: true });
    expect((await app.inject({ method: "GET", url: "/api/devices" })).statusCode).toBe(401);
    const cookie = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/setup", payload: admin }));
    const off = await app.inject({ method: "GET", url: "/api/devices", headers: { cookie } });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe("LINK_DISABLED");
  });

  it("a computer joins with an invite, waits, and reaches ModelDock once approved", async () => {
    const { app, cookie } = await startWithLink();
    const devices = (await app.inject({ method: "GET", url: "/api/devices", headers: { cookie } })).json();
    expect(devices.connection.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const invite = await app.inject({ method: "POST", url: "/api/devices/invites", headers: { cookie }, payload: { requirePin: true } });
    // A test machine may not be on a local network: then there is nobody to invite, and the API says so.
    if (invite.statusCode === 409) {
      expect(invite.json().error.code).toBe("LINK_NO_NETWORK");
      return;
    }
    expect(invite.statusCode).toBe(201);
    const { link, pin } = invite.json();
    expect(pin).toMatch(/^\d{6}$/);

    // The invite points at the local network addresses; in the test the connection listens on loopback.
    const linkPort = devices.connection.port as number;
    const local = link.replace(/https:\/\/[^/]+\/join#/, `https://127.0.0.1:${linkPort}/join#`).replace(/h=[^&]+/, `h=127.0.0.1%3A${linkPort}`);
    const joined = await joinWithLink(local, { hostname: "portatile", pin });
    expect(joined.authorized).toBe(false);

    const target = { host: "127.0.0.1", port: linkPort };
    const asDevice = { target, fingerprint: joined.credentials.fingerprint, method: "GET", path: "/api/health", headers: { [TOKEN_HEADER]: joined.credentials.token } };
    expect((await pinnedRequest(asDevice)).status).toBe(403);

    const listed = (await app.inject({ method: "GET", url: "/api/devices", headers: { cookie } })).json();
    expect(listed.devices).toEqual([expect.objectContaining({ id: joined.credentials.deviceId, hostname: "portatile", authorized: false })]);
    expect((await app.inject({ method: "PATCH", url: `/api/devices/${joined.credentials.deviceId}`, headers: { cookie }, payload: { authorized: true } })).statusCode).toBe(200);

    const through = await pinnedRequest(asDevice);
    expect(through.status).toBe(200);
    expect(JSON.parse(through.body.toString())).toMatchObject({ service: "modeldock-api" });

    expect((await app.inject({ method: "DELETE", url: `/api/devices/${joined.credentials.deviceId}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await pinnedRequest(asDevice)).status).toBe(401);
  });

  it("a browser without a device credential gets through only when allowed, and still meets the login", async () => {
    const closed = await startWithLink(false);
    const closedPort = (await closed.app.inject({ method: "GET", url: "/api/devices", headers: { cookie: closed.cookie } })).json().connection;
    const fingerprintClosed = closedPort.fingerprint as string;
    expect((await pinnedRequest({ target: { host: "127.0.0.1", port: closedPort.port }, fingerprint: fingerprintClosed, method: "GET", path: "/api/health" })).status).toBe(401);

    const open = await startWithLink(true);
    const connection = (await open.app.inject({ method: "GET", url: "/api/devices", headers: { cookie: open.cookie } })).json().connection;
    const target = { host: "127.0.0.1", port: connection.port };
    expect((await pinnedRequest({ target, fingerprint: connection.fingerprint, method: "GET", path: "/api/health" })).status).toBe(200);
    // Past the connection, ModelDock's own login still applies.
    expect((await pinnedRequest({ target, fingerprint: connection.fingerprint, method: "GET", path: "/api/system/status" })).status).toBe(401);
  });

  it("status reports the connection once it runs", async () => {
    const { app, cookie } = await startWithLink();
    const status = (await app.inject({ method: "GET", url: "/api/system/status", headers: { cookie } })).json();
    expect(["available", "degraded"]).toContain(status.components.link.status);
  });
});
