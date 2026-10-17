import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";

const admin = { email: "simone@example.com", displayName: "Simone", password: "una-password-lunga" };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function cookieFrom(response: LightMyRequestResponse): string {
  return String(response.headers["set-cookie"] ?? "").split(";")[0] ?? "";
}

async function start() {
  const app = await buildApp({ ollamaMode: "fake", requireLogin: true });
  apps.push(app);
  const adminCookie = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/setup", payload: admin }));
  const invite = await app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { cookie: adminCookie },
    payload: { email: "anna@example.com", displayName: "Anna" }
  });
  const accepted = await app.inject({ method: "POST", url: `/api/auth/invitations/${invite.json().token}/accept`, payload: { password: "password-di-anna" } });
  return { app, adminCookie, memberCookie: cookieFrom(accepted) };
}

describe("API keys", () => {
  it("needs a signed-in account", async () => {
    const { app } = await start();
    expect((await app.inject({ method: "GET", url: "/api/api-keys" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/api-keys", payload: { name: "x" } })).statusCode).toBe(401);
  });

  it("a member creates, lists and revokes their own keys; the secret is returned once", async () => {
    const { app, memberCookie } = await start();
    const created = await app.inject({ method: "POST", url: "/api/api-keys", headers: { cookie: memberCookie }, payload: { name: "Script" } });
    expect(created.statusCode).toBe(201);
    const { key, secret } = created.json();
    expect(secret).toMatch(/^mdk_/);

    const list = await app.inject({ method: "GET", url: "/api/api-keys", headers: { cookie: memberCookie } });
    expect(list.json()).toEqual([expect.objectContaining({ id: key.id, name: "Script", hint: key.hint })]);
    expect(list.body).not.toContain(secret);

    const revoked = await app.inject({ method: "DELETE", url: `/api/api-keys/${key.id}`, headers: { cookie: memberCookie } });
    expect(revoked.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/api-keys", headers: { cookie: memberCookie } })).json()).toEqual([]);
  });

  it("a member cannot see everyone's keys nor revoke someone else's", async () => {
    const { app, adminCookie, memberCookie } = await start();
    const adminKey = (await app.inject({ method: "POST", url: "/api/api-keys", headers: { cookie: adminCookie }, payload: { name: "admin" } })).json().key;
    expect((await app.inject({ method: "GET", url: "/api/api-keys?scope=all", headers: { cookie: memberCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/api-keys/${adminKey.id}`, headers: { cookie: memberCookie } })).statusCode).toBe(404);
  });

  it("an administrator sees everyone's keys with their owner and can revoke them", async () => {
    const { app, adminCookie, memberCookie } = await start();
    const memberKey = (await app.inject({ method: "POST", url: "/api/api-keys", headers: { cookie: memberCookie }, payload: { name: "di Anna" } })).json().key;
    const all = await app.inject({ method: "GET", url: "/api/api-keys?scope=all", headers: { cookie: adminCookie } });
    expect(all.json()).toEqual([expect.objectContaining({ name: "di Anna", owner: expect.objectContaining({ displayName: "Anna" }) })]);
    expect((await app.inject({ method: "DELETE", url: `/api/api-keys/${memberKey.id}`, headers: { cookie: adminCookie } })).statusCode).toBe(204);
  });

  it("a key is not a login: it does not open the account routes", async () => {
    const { app, adminCookie } = await start();
    const { secret } = (await app.inject({ method: "POST", url: "/api/api-keys", headers: { cookie: adminCookie }, payload: { name: "a" } })).json();
    const response = await app.inject({ method: "GET", url: "/api/users", headers: { authorization: `Bearer ${secret}` } });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an empty name with a clear error", async () => {
    const { app, adminCookie } = await start();
    const response = await app.inject({ method: "POST", url: "/api/api-keys", headers: { cookie: adminCookie }, payload: { name: "" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("API_KEY_NAME_INVALID");
  });
});
