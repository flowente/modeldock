import type { AddressInfo } from "node:net";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { FakeOllamaGateway } from "@modeldock/testing";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import type { ChatStreamEvent } from "./chat-routes.ts";

const admin = { email: "simone@example.com", displayName: "Simone", password: "una-password-lunga" };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function start(options: Parameters<typeof buildApp>[0] = {}) {
  const app = await buildApp({ ollamaMode: "fake", tailscaleMode: "fake", ...options });
  apps.push(app);
  return app;
}

function cookieFrom(response: LightMyRequestResponse): string {
  return String(response.headers["set-cookie"] ?? "").split(";")[0] ?? "";
}

async function signedIn(app: FastifyInstance) {
  const adminCookie = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/setup", payload: admin }));
  const invite = await app.inject({ method: "POST", url: "/api/invitations", headers: { cookie: adminCookie }, payload: { email: "anna@example.com", displayName: "Anna" } });
  const memberCookie = cookieFrom(await app.inject({ method: "POST", url: `/api/auth/invitations/${invite.json().token}/accept`, payload: { password: "password-di-anna" } }));
  return { adminCookie, memberCookie };
}

function events(response: LightMyRequestResponse): ChatStreamEvent[] {
  return response.body.trim().split("\n").map((line) => JSON.parse(line) as ChatStreamEvent);
}

describe("chat API", () => {
  it("needs an account, even when login is not required for the dashboard", async () => {
    const app = await start();
    expect((await app.inject({ method: "GET", url: "/api/chat/models" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/chat/messages", payload: { model: "phi3:mini", content: "ciao" } })).statusCode).toBe(401);
  });

  it("lists only the models the account may use", async () => {
    const app = await start();
    const { adminCookie, memberCookie } = await signedIn(app);

    const forAdmin = (await app.inject({ method: "GET", url: "/api/chat/models", headers: { cookie: adminCookie } })).json();
    // The demo data has llama3.3:70b disabled: not even an administrator chats with a switched-off model.
    expect(forAdmin.map((model: { name: string }) => model.name).sort()).toEqual(["llama3.1:8b", "phi3:mini"]);

    // A new member belongs to no group yet, so nothing is granted to them.
    expect((await app.inject({ method: "GET", url: "/api/chat/models", headers: { cookie: memberCookie } })).json()).toEqual([]);
  });

  it("leaves out models that cannot chat, such as embedding models", async () => {
    const gateway = new FakeOllamaGateway();
    gateway.embeddingModels.add("phi3:mini");
    const app = await start({ ollamaGateway: gateway });
    const { adminCookie } = await signedIn(app);
    const names = (await app.inject({ method: "GET", url: "/api/chat/models", headers: { cookie: adminCookie } })).json().map((model: { name: string }) => model.name);
    expect(names).toEqual(["llama3.1:8b"]);
    const refused = await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "phi3:mini", content: "ciao" } });
    expect(refused.statusCode).toBe(403);
  });

  it("refuses a model the account is not granted, even if the request names it directly", async () => {
    const app = await start();
    const { memberCookie } = await signedIn(app);
    const response = await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: memberCookie }, payload: { model: "phi3:mini", content: "ciao" } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CHAT_MODEL_NOT_ALLOWED");
  });

  it("a first message starts a conversation, streams the reply and saves both", async () => {
    const app = await start();
    const { adminCookie } = await signedIn(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { cookie: adminCookie },
      payload: { model: "phi3:mini", content: "Spiegami WireGuard in due righe" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");

    const stream = events(response);
    expect(stream[0]).toMatchObject({ type: "conversation", conversation: { title: "Spiegami WireGuard in due righe", model: "phi3:mini" } });
    expect(stream[1]).toMatchObject({ type: "message", message: { role: "user" } });
    const text = stream.filter((event) => event.type === "delta").map((event) => (event as { content: string }).content).join("");
    expect(text).toBe("Fake reply from phi3:mini to: Spiegami WireGuard in due righe");
    expect(stream.at(-1)).toMatchObject({ type: "done", message: { role: "assistant", status: "complete", content: text } });

    const id = (stream[0] as { conversation: { id: string } }).conversation.id;
    const saved = (await app.inject({ method: "GET", url: `/api/chat/conversations/${id}`, headers: { cookie: adminCookie } })).json();
    expect(saved.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
  });

  it("follow-up messages send the earlier turns to the model", async () => {
    const seen: string[][] = [];
    const gateway = new FakeOllamaGateway();
    const original = gateway.chat.bind(gateway);
    gateway.chat = (input) => {
      seen.push(input.messages.map((message) => `${message.role}:${message.content}`));
      return original(input);
    };
    const app = await start({ ollamaGateway: gateway });
    const { adminCookie } = await signedIn(app);

    const first = events(await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "phi3:mini", content: "uno" } }));
    const id = (first[0] as { conversation: { id: string } }).conversation.id;
    await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { conversationId: id, model: "phi3:mini", content: "due" } });

    expect(seen[1]).toEqual(["user:uno", "assistant:Fake reply from phi3:mini to: uno", "user:due"]);
  });

  it("conversations belong to their owner: others get 'not found'", async () => {
    const app = await start();
    const { adminCookie, memberCookie } = await signedIn(app);
    const stream = events(await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "phi3:mini", content: "privato" } }));
    const id = (stream[0] as { conversation: { id: string } }).conversation.id;

    for (const [method, payload] of [["GET", undefined], ["PATCH", { title: "rubato" }], ["DELETE", undefined]] as const) {
      const response = await app.inject({ method, url: `/api/chat/conversations/${id}`, headers: { cookie: memberCookie }, ...(payload ? { payload } : {}) });
      expect(response.statusCode, method).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: "/api/chat/conversations", headers: { cookie: memberCookie } })).json()).toEqual([]);
  });

  it("rename, search by title or text, delete", async () => {
    const app = await start();
    const { adminCookie } = await signedIn(app);
    const send = async (content: string) =>
      (events(await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "phi3:mini", content } }))[0] as {
        conversation: { id: string };
      }).conversation.id;
    const csv = await send("Somma gli importi del CSV");
    await send("Scrivi un'email al cliente");

    await app.inject({ method: "PATCH", url: `/api/chat/conversations/${csv}`, headers: { cookie: adminCookie }, payload: { title: "Conti di settembre" } });
    const byTitle = (await app.inject({ method: "GET", url: "/api/chat/conversations?q=settembre", headers: { cookie: adminCookie } })).json();
    expect(byTitle.map((conversation: { title: string }) => conversation.title)).toEqual(["Conti di settembre"]);
    const byText = (await app.inject({ method: "GET", url: "/api/chat/conversations?q=importi", headers: { cookie: adminCookie } })).json();
    expect(byText).toHaveLength(1);
    // A % typed in the search is a percent sign, not "match everything".
    expect((await app.inject({ method: "GET", url: "/api/chat/conversations?q=%25", headers: { cookie: adminCookie } })).json()).toEqual([]);

    expect((await app.inject({ method: "DELETE", url: `/api/chat/conversations/${csv}`, headers: { cookie: adminCookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/chat/conversations", headers: { cookie: adminCookie } })).json()).toHaveLength(1);
  });

  it("long titles are shortened from the first message", async () => {
    const app = await start();
    const { adminCookie } = await signedIn(app);
    const long = `${"parola ".repeat(30)}fine`;
    const stream = events(await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "phi3:mini", content: long } }));
    const title = (stream[0] as { conversation: { title: string } }).conversation.title;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("closing the request stops the model and keeps the partial answer as 'stopped'", async () => {
    const gateway = new FakeOllamaGateway();
    gateway.chatDelayMs = 40;
    const app = await start({ ollamaGateway: gateway });
    const { adminCookie } = await signedIn(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const sockets: import("node:net").Socket[] = [];
    app.server.on("connection", (socket) => sockets.push(socket));
    const { port } = app.server.address() as AddressInfo;

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/chat/messages`, {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ model: "phi3:mini", content: "una risposta lunga per favore" }),
      signal: controller.signal
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes('"type":"delta"')) {
      const { value } = await reader.read();
      received += decoder.decode(value);
    }
    const conversationId = (JSON.parse(received.split("\n")[0]!) as { conversation: { id: string } }).conversation.id;
    controller.abort();

    await expect
      .poll(
        async () => {
          const saved = (await app.inject({ method: "GET", url: `/api/chat/conversations/${conversationId}`, headers: { cookie: adminCookie } })).json();
          return saved.messages.at(-1)?.status;
        },
        { timeout: 3000 }
      )
      .toBe("stopped");
    const saved = (await app.inject({ method: "GET", url: `/api/chat/conversations/${conversationId}`, headers: { cookie: adminCookie } })).json();
    const partial = saved.messages.at(-1).content as string;
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan("Fake reply from phi3:mini to: una risposta lunga per favore".length);
    // A stopped reply must not leave its connection hanging on the server.
    await expect.poll(() => sockets[0]?.destroyed, { timeout: 3000 }).toBe(true);
    // The test's HTTP client may open a spare connection it never uses; Node waits on those until a timeout.
    app.server.closeAllConnections();
  });

  it("with login required, a member can chat but still not reach the dashboard", async () => {
    const app = await start({ requireLogin: true });
    const { adminCookie, memberCookie } = await signedIn(app);
    const groups = await app.inject({ method: "POST", url: "/api/groups", headers: { cookie: adminCookie }, payload: { name: "Team" } });
    const users = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: adminCookie } })).json();
    const anna = users.find((user: { email: string }) => user.email === "anna@example.com");
    await app.inject({ method: "PATCH", url: `/api/users/${anna.id}`, headers: { cookie: adminCookie }, payload: { groupIds: [groups.json().id] } });
    await app.inject({ method: "PUT", url: "/api/access/model-policies", headers: { cookie: adminCookie }, payload: { modelName: "phi3:mini", groupGrants: { [groups.json().id]: true } } });

    expect((await app.inject({ method: "GET", url: "/api/chat/models", headers: { cookie: memberCookie } })).json()).toEqual([
      expect.objectContaining({ name: "phi3:mini" })
    ]);
    const reply = await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: memberCookie }, payload: { model: "phi3:mini", content: "ciao" } });
    expect(events(reply).at(-1)).toMatchObject({ type: "done" });
    expect((await app.inject({ method: "GET", url: "/api/system/status", headers: { cookie: memberCookie } })).statusCode).toBe(403);
  });
});
