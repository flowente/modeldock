import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { SESSION_COOKIE } from "./auth-routes.ts";

const admin = { email: "simone@example.com", displayName: "Simone", password: "una-password-lunga" };
const apps: FastifyInstance[] = [];

async function start(options: Parameters<typeof buildApp>[0] = {}) {
  const app = await buildApp({ ollamaMode: "fake", tailscaleMode: "fake", ...options });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function cookieFrom(response: LightMyRequestResponse): string {
  const header = String(response.headers["set-cookie"] ?? "");
  const value = header.split(";")[0] ?? "";
  expect(value.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return value;
}

async function setupAdmin(app: FastifyInstance): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/auth/setup", payload: admin });
  expect(response.statusCode).toBe(201);
  return cookieFrom(response);
}

describe("account API", () => {
  it("first run: setup required, then the administrator is created and signed in", async () => {
    const app = await start();
    const before = await app.inject({ method: "GET", url: "/api/auth/state" });
    expect(before.json()).toMatchObject({ setupRequired: true, account: null, requireLogin: false });

    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: admin });
    expect(setup.statusCode).toBe(201);
    const header = String(setup.headers["set-cookie"]);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).not.toContain("Secure");
    expect(setup.json().account).not.toHaveProperty("passwordHash");

    const after = await app.inject({ method: "GET", url: "/api/auth/state", headers: { cookie: cookieFrom(setup) } });
    expect(after.json()).toMatchObject({ setupRequired: false, account: { email: admin.email, role: "admin" } });

    const again = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { ...admin, email: "x@example.com" } });
    expect(again.statusCode).toBe(409);
  });

  it("login, me, logout", async () => {
    const app = await start();
    await setupAdmin(app);

    const wrong = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: admin.email, password: "sbagliata-123" } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe("ACCOUNT_LOGIN_FAILED");

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: admin.email, password: admin.password } });
    expect(login.statusCode).toBe(200);
    const cookie = cookieFrom(login);

    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json()).toMatchObject({ email: admin.email });
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("blocks login after repeated failures from the same address", async () => {
    const app = await start();
    await setupAdmin(app);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: admin.email, password: "sbagliata-123" } });
    }
    const blocked = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: admin.email, password: admin.password } });
    expect(blocked.statusCode).toBe(429);
  });

  it("invitation flow: the admin invites, the person sets a password and is signed in as a member", async () => {
    const app = await start();
    const cookie = await setupAdmin(app);
    const group = await app.inject({ method: "POST", url: "/api/groups", headers: { cookie }, payload: { name: "Team" } });
    expect(group.statusCode).toBe(201);

    const invite = await app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: { cookie },
      payload: { email: "anna@example.com", displayName: "Anna", groupIds: [group.json().id] }
    });
    expect(invite.statusCode).toBe(201);
    const { token, acceptPath } = invite.json();
    expect(acceptPath).toBe(`/#/invito/${token}`);

    const preview = await app.inject({ method: "GET", url: `/api/auth/invitations/${token}` });
    expect(preview.json()).toMatchObject({ email: "anna@example.com", displayName: "Anna" });

    const accepted = await app.inject({ method: "POST", url: `/api/auth/invitations/${token}/accept`, payload: { password: "password-di-anna" } });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().account).toMatchObject({ role: "member", groupIds: [group.json().id] });

    const reused = await app.inject({ method: "POST", url: `/api/auth/invitations/${token}/accept`, payload: { password: "password-di-anna" } });
    expect(reused.statusCode).toBe(410);
  });

  it("account management is for administrators only, even with login not required", async () => {
    const app = await start();
    const adminCookie = await setupAdmin(app);

    expect((await app.inject({ method: "GET", url: "/api/users" })).statusCode).toBe(401);

    const invite = await app.inject({ method: "POST", url: "/api/invitations", headers: { cookie: adminCookie }, payload: { email: "m@example.com", displayName: "M" } });
    const member = await app.inject({ method: "POST", url: `/api/auth/invitations/${invite.json().token}/accept`, payload: { password: "password-di-m" } });
    const memberCookie = cookieFrom(member);

    for (const [method, url] of [
      ["GET", "/api/users"],
      ["GET", "/api/groups"],
      ["POST", "/api/invitations"],
      ["PUT", "/api/access/model-policies/phi3/users/usr_x"]
    ] as const) {
      const response = await app.inject({ method, url, headers: { cookie: memberCookie }, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }

    const users = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: adminCookie } });
    expect(users.json()).toHaveLength(2);
    expect(JSON.stringify(users.json())).not.toContain("passwordHash");
  });

  it("anyone signed in can change their own name, and only their name", async () => {
    const app = await start();
    const cookie = await setupAdmin(app);
    const renamed = await app.inject({ method: "PATCH", url: "/api/auth/me", headers: { cookie }, payload: { displayName: "Simone G.", role: "member" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ displayName: "Simone G.", role: "admin" });
    expect((await app.inject({ method: "PATCH", url: "/api/auth/me", payload: { displayName: "x" } })).statusCode).toBe(401);
  });

  it("an administrator cannot delete their own account or remove the last administrator", async () => {
    const app = await start();
    const cookie = await setupAdmin(app);
    const me = (await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json();

    expect((await app.inject({ method: "DELETE", url: `/api/users/${me.id}`, headers: { cookie } })).statusCode).toBe(409);
    const demote = await app.inject({ method: "PATCH", url: `/api/users/${me.id}`, headers: { cookie }, payload: { role: "member" } });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe("ACCOUNT_LAST_ADMIN");
  });

  it("with login required, the existing API needs an account and the right role", async () => {
    const app = await start({ requireLogin: true });

    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/state" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/system/status" })).statusCode).toBe(401);

    const adminCookie = await setupAdmin(app);
    expect((await app.inject({ method: "GET", url: "/api/system/status", headers: { cookie: adminCookie } })).statusCode).toBe(200);

    const invite = await app.inject({ method: "POST", url: "/api/invitations", headers: { cookie: adminCookie }, payload: { email: "v@example.com", displayName: "V", role: "member" } });
    const member = await app.inject({ method: "POST", url: `/api/auth/invitations/${invite.json().token}/accept`, payload: { password: "password-di-v" } });
    const memberCookie = cookieFrom(member);

    // A member only chats: the dashboard API is not theirs.
    expect((await app.inject({ method: "GET", url: "/api/system/status", headers: { cookie: memberCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/models/pull", headers: { cookie: memberCookie }, payload: { name: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: memberCookie } })).statusCode).toBe(200);
  });

  it("with a database file, accounts and permissions survive a restart and the status says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "modeldock-api-"));
    const databasePath = join(dir, "modeldock.db");
    try {
      const first = await start({ databasePath });
      const cookie = await setupAdmin(first);
      const status = (await first.inject({ method: "GET", url: "/api/system/status" })).json();
      expect(status.components.storage).toMatchObject({ status: "available" });
      const policy = await first.inject({ method: "PUT", url: "/api/access/model-policies/phi3:mini/users/usr_qualcuno", headers: { cookie }, payload: { canUse: true } });
      expect(policy.json().grants).toEqual([{ subject: { type: "user", id: "usr_qualcuno" }, canUse: true }]);
      await first.close();
      apps.splice(apps.indexOf(first), 1);

      const second = await start({ databasePath });
      expect((await second.inject({ method: "GET", url: "/api/auth/state" })).json().setupRequired).toBe(false);
      const login = await second.inject({ method: "POST", url: "/api/auth/login", payload: { email: admin.email, password: admin.password } });
      expect(login.statusCode).toBe(200);
      // The audit log is in the file too: the setup from the first run is still there.
      const audit = await second.inject({ method: "GET", url: "/api/audit/events" });
      expect(JSON.stringify(audit.json())).toContain("ACCOUNT_SETUP_COMPLETED");
      await second.close();
      apps.splice(apps.indexOf(second), 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("without a database file, storage is reported as temporary", async () => {
    const app = await start();
    const status = (await app.inject({ method: "GET", url: "/api/system/status" })).json();
    expect(status.components.storage).toMatchObject({ status: "degraded" });
  });
});
