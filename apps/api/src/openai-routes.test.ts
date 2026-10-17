import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { FakeOllamaGateway } from "@modeldock/testing";
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
  const gateway = new FakeOllamaGateway();
  const app = await buildApp({ ollamaMode: "fake", ollamaGateway: gateway, requireLogin: true });
  apps.push(app);
  const adminCookie = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/setup", payload: admin }));
  const invite = await app.inject({ method: "POST", url: "/api/invitations", headers: { cookie: adminCookie }, payload: { email: "anna@example.com", displayName: "Anna" } });
  const accepted = await app.inject({ method: "POST", url: `/api/auth/invitations/${invite.json().token}/accept`, payload: { password: "password-di-anna" } });
  const memberCookie = cookieFrom(accepted);
  const memberId = accepted.json().account.id as string;
  const keyFor = async (cookie: string) =>
    (await app.inject({ method: "POST", url: "/api/api-keys", headers: { cookie }, payload: { name: "test" } })).json().secret as string;
  return { app, gateway, adminCookie, memberCookie, memberId, adminKey: await keyFor(adminCookie), memberKey: await keyFor(memberCookie) };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe("OpenAI-compatible API", () => {
  it("refuses calls without a key, with a wrong key, or with only a browser session", async () => {
    const { app, adminCookie } = await start();
    for (const headers of [{}, bearer("mdk_sbagliata"), { cookie: adminCookie }]) {
      const response = await app.inject({ method: "GET", url: "/v1/models", headers });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toMatchObject({ type: "authentication_error" });
    }
  });

  it("a revoked key stops working at once", async () => {
    const { app, adminCookie, adminKey } = await start();
    const [key] = (await app.inject({ method: "GET", url: "/api/api-keys", headers: { cookie: adminCookie } })).json();
    await app.inject({ method: "DELETE", url: `/api/api-keys/${key.id}`, headers: { cookie: adminCookie } });
    expect((await app.inject({ method: "GET", url: "/v1/models", headers: bearer(adminKey) })).statusCode).toBe(401);
  });

  it("lists only the models the key's account may use", async () => {
    const { app, adminCookie, adminKey, memberKey, memberId } = await start();
    const all = await app.inject({ method: "GET", url: "/v1/models", headers: bearer(adminKey) });
    expect(all.json()).toMatchObject({ object: "list" });
    // The fake permissions keep llama3.3:70b disabled: not even an administrator gets it.
    expect(all.json().data.map((model: { id: string }) => model.id)).toEqual(["llama3.1:8b", "phi3:mini"]);
    expect(all.json().data[0]).toMatchObject({ object: "model", owned_by: "modeldock", created: expect.any(Number) });

    // A member starts with nothing, then gets one model.
    expect((await app.inject({ method: "GET", url: "/v1/models", headers: bearer(memberKey) })).json().data).toEqual([]);
    await app.inject({ method: "PUT", url: `/api/access/model-policies/phi3:mini/users/${memberId}`, headers: { cookie: adminCookie }, payload: { canUse: true } });
    const granted = await app.inject({ method: "GET", url: "/v1/models", headers: bearer(memberKey) });
    expect(granted.json().data.map((model: { id: string }) => model.id)).toEqual(["phi3:mini"]);
    expect((await app.inject({ method: "GET", url: "/v1/models/phi3:mini", headers: bearer(memberKey) })).json()).toMatchObject({ id: "phi3:mini" });
    expect((await app.inject({ method: "GET", url: "/v1/models/llama3.1:8b", headers: bearer(memberKey) })).statusCode).toBe(404);
  });

  it("answers a chat completion and forwards the request untouched", async () => {
    const { app, gateway, adminKey } = await start();
    const body = { model: "llama3.1:8b", messages: [{ role: "user", content: "ciao" }], temperature: 0.2, tools: [] };
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: bearer(adminKey), payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "Fake reply from llama3.1:8b to: ciao" } }],
      usage: { prompt_tokens: 5 }
    });
    expect(gateway.lastOpenAiRequest).toMatchObject({ endpoint: "/v1/chat/completions", body });
  });

  it("streams a chat completion as server-sent events", async () => {
    const { app, adminKey } = await start();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: bearer(adminKey),
      payload: { model: "llama3.1:8b", messages: [{ role: "user", content: "ciao" }], stream: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const events = response.body.split("\n\n").filter(Boolean);
    expect(events.at(-1)).toBe("data: [DONE]");
    const text = events
      .slice(0, -1)
      .map((event) => JSON.parse(event.replace(/^data: /, "")).choices[0]?.delta?.content ?? "")
      .join("");
    expect(text).toBe("Fake reply from llama3.1:8b to: ciao");
  });

  it("a model the account may not use answers like a missing one, and never reaches Ollama", async () => {
    const { app, gateway, memberKey } = await start();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: bearer(memberKey),
      payload: { model: "llama3.1:8b", messages: [{ role: "user", content: "ciao" }] }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: "model_not_found", type: "not_found_error" });
    expect(gateway.lastOpenAiRequest).toBeUndefined();

    const missing = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: bearer(memberKey), payload: { model: "non-esiste", messages: [] } });
    expect(missing.json().error.message).toBe(response.json().error.message.replace("llama3.1:8b", "non-esiste"));
  });

  it("a disabled model is refused even to administrators", async () => {
    const { app, adminCookie, adminKey } = await start();
    await app.inject({ method: "PUT", url: "/api/access/model-policies", headers: { cookie: adminCookie }, payload: { modelName: "phi3:mini", enabled: false } });
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: bearer(adminKey), payload: { model: "phi3:mini", messages: [] } });
    expect(response.statusCode).toBe(404);
  });

  it("returns embeddings", async () => {
    const { app, adminKey } = await start();
    const response = await app.inject({ method: "POST", url: "/v1/embeddings", headers: bearer(adminKey), payload: { model: "phi3:mini", input: ["uno", "due"] } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(2);
  });

  it("explains a missing model parameter and an unknown endpoint the OpenAI way", async () => {
    const { app, adminKey } = await start();
    const noModel = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: bearer(adminKey), payload: { messages: [] } });
    expect(noModel.statusCode).toBe(400);
    expect(noModel.json().error).toMatchObject({ code: "missing_model", type: "invalid_request_error", param: null });
    const unknown = await app.inject({ method: "POST", url: "/v1/images/generations", headers: bearer(adminKey), payload: {} });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("unknown_endpoint");
  });

  it("does not put API calls in the chat history", async () => {
    const { app, adminCookie, adminKey } = await start();
    await app.inject({ method: "POST", url: "/v1/chat/completions", headers: bearer(adminKey), payload: { model: "phi3:mini", messages: [{ role: "user", content: "ciao" }] } });
    expect((await app.inject({ method: "GET", url: "/api/chat/conversations", headers: { cookie: adminCookie } })).json()).toEqual([]);
  });
});
