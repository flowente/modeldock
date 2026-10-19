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

function cookieFrom(response: LightMyRequestResponse): string {
  return String(response.headers["set-cookie"] ?? "").split(";")[0] ?? "";
}

function events(response: LightMyRequestResponse): ChatStreamEvent[] {
  return response.body.trim().split("\n").map((line) => JSON.parse(line) as ChatStreamEvent);
}

async function start() {
  const gateway = new FakeOllamaGateway();
  const app = await buildApp({ ollamaMode: "fake", ollamaGateway: gateway });
  apps.push(app);
  const adminCookie = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/setup", payload: admin }));
  const group = (await app.inject({ method: "POST", url: "/api/groups", headers: { cookie: adminCookie }, payload: { name: "Team" } })).json();
  const invite = await app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { cookie: adminCookie },
    payload: { email: "anna@example.com", displayName: "Anna", groupIds: [group.id] }
  });
  const accepted = await app.inject({ method: "POST", url: `/api/auth/invitations/${invite.json().token}/accept`, payload: { password: "password-di-anna" } });
  // Anna may chat with llama3.1:8b.
  await app.inject({
    method: "PUT",
    url: `/api/access/model-policies/llama3.1:8b/users/${accepted.json().account.id}`,
    headers: { cookie: adminCookie },
    payload: { canUse: true }
  });
  return { app, gateway, adminCookie, memberCookie: cookieFrom(accepted), groupId: group.id as string };
}

const brand = { name: "Flowente brand", description: "Tono e listino", instructions: "Rispondi con il tono di Flowente.", reference: "Listino: AI Pilota.", model: "llama3.1:8b" };

describe("projects", () => {
  it("instructions and references reach the model for the whole conversation", async () => {
    const { app, gateway, adminCookie } = await start();
    const project = (await app.inject({ method: "POST", url: "/api/chat/projects", headers: { cookie: adminCookie }, payload: brand })).json();
    expect(project).toMatchObject({ name: "Flowente brand", editable: true, shared: false });

    const first = events(
      await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "llama3.1:8b", content: "ciao", projectId: project.id } })
    );
    const conversation = first.find((event) => event.type === "conversation");
    expect(conversation).toMatchObject({ conversation: { projectId: project.id } });
    const system = gateway.lastChatInput?.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("Rispondi con il tono di Flowente.");
    expect(system?.content).toContain("Listino: AI Pilota.");

    // The second message, without saying so, still carries the project.
    const id = conversation?.type === "conversation" ? conversation.conversation.id : "";
    await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "llama3.1:8b", content: "e poi?", conversationId: id } });
    expect(gateway.lastChatInput?.messages[0]?.content).toContain("Rispondi con il tono di Flowente.");

    const inProject = (await app.inject({ method: "GET", url: `/api/chat/conversations?projectId=${project.id}`, headers: { cookie: adminCookie } })).json();
    expect(inProject.map((item: { id: string }) => item.id)).toEqual([id]);
  });

  it("a project given to a group reaches its members, and their chats stay their own", async () => {
    const { app, adminCookie, memberCookie, groupId } = await start();
    const project = (
      await app.inject({ method: "POST", url: "/api/chat/projects", headers: { cookie: adminCookie }, payload: { ...brand, access: [{ type: "group", id: groupId }] } })
    ).json();
    expect(project.shared).toBe(true);

    const forMember = (await app.inject({ method: "GET", url: "/api/chat/projects", headers: { cookie: memberCookie } })).json();
    expect(forMember).toEqual([expect.objectContaining({ id: project.id, editable: false })]);
    expect(forMember[0]).not.toHaveProperty("instructions");

    const reply = await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: memberCookie }, payload: { model: "llama3.1:8b", content: "ciao", projectId: project.id } });
    expect(reply.statusCode).toBe(200);
    // The administrator does not see the member's conversation.
    expect((await app.inject({ method: "GET", url: `/api/chat/conversations?projectId=${project.id}`, headers: { cookie: adminCookie } })).json()).toEqual([]);

    expect((await app.inject({ method: "PUT", url: `/api/chat/projects/${project.id}`, headers: { cookie: memberCookie }, payload: brand })).statusCode).toBe(403);
  });

  it("a personal project stays personal, even in an administrator's chat picker", async () => {
    const { app, adminCookie, memberCookie } = await start();
    const mine = (await app.inject({ method: "POST", url: "/api/chat/projects", headers: { cookie: memberCookie }, payload: { ...brand, name: "Mio" } })).json();
    expect((await app.inject({ method: "GET", url: "/api/chat/projects", headers: { cookie: adminCookie } })).json()).toEqual([]);
    // In the settings the administrator can still manage it.
    expect((await app.inject({ method: "GET", url: "/api/chat/projects/manage", headers: { cookie: adminCookie } })).json()).toEqual([
      expect.objectContaining({ id: mine.id })
    ]);
    // A member cannot give a project to others.
    const shareAttempt = await app.inject({ method: "PUT", url: `/api/chat/projects/${mine.id}`, headers: { cookie: memberCookie }, payload: { ...brand, access: [] } });
    expect(shareAttempt.statusCode).toBe(403);
  });

  it("someone without access is told the project does not exist, and nothing is saved", async () => {
    const { app, adminCookie, memberCookie } = await start();
    const project = (await app.inject({ method: "POST", url: "/api/chat/projects", headers: { cookie: adminCookie }, payload: brand })).json();
    expect((await app.inject({ method: "GET", url: `/api/chat/projects/${project.id}`, headers: { cookie: memberCookie } })).statusCode).toBe(404);
    const attempt = await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: memberCookie }, payload: { model: "llama3.1:8b", content: "ciao", projectId: project.id } });
    expect(attempt.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/chat/conversations", headers: { cookie: memberCookie } })).json()).toEqual([]);
  });

  it("deleting a project keeps its conversations, without the project", async () => {
    const { app, adminCookie } = await start();
    const project = (await app.inject({ method: "POST", url: "/api/chat/projects", headers: { cookie: adminCookie }, payload: brand })).json();
    await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "llama3.1:8b", content: "ciao", projectId: project.id } });
    expect((await app.inject({ method: "DELETE", url: `/api/chat/projects/${project.id}`, headers: { cookie: adminCookie } })).statusCode).toBe(204);
    const [conversation] = (await app.inject({ method: "GET", url: "/api/chat/conversations", headers: { cookie: adminCookie } })).json();
    expect(conversation).toBeDefined();
    expect(conversation).not.toHaveProperty("projectId");
  });

  it("warns when the model read up to its limit, because the start was cut", async () => {
    const { app, gateway, adminCookie } = await start();
    gateway.contextLength = 100;
    const project = (await app.inject({ method: "POST", url: "/api/chat/projects", headers: { cookie: adminCookie }, payload: { ...brand, reference: "x".repeat(2000) } })).json();
    const reply = events(
      await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "llama3.1:8b", content: "ciao", projectId: project.id } })
    );
    expect(reply.find((event) => event.type === "notice")).toEqual({ type: "notice", code: "CONTEXT_FULL", promptTokens: 100, contextLength: 100 });

    gateway.contextLength = 4096;
    const short = events(await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "llama3.1:8b", content: "ciao" } }));
    expect(short.some((event) => event.type === "notice")).toBe(false);
  });

  it("validates the fields", async () => {
    const { app, adminCookie } = await start();
    const empty = await app.inject({ method: "POST", url: "/api/chat/projects", headers: { cookie: adminCookie }, payload: { ...brand, name: " " } });
    expect(empty.json().error.code).toBe("PROJECT_FIELD_INVALID");
    const badAccess = await app.inject({
      method: "POST",
      url: "/api/chat/projects",
      headers: { cookie: adminCookie },
      payload: { ...brand, access: [{ type: "group", id: "grp_nope" }] }
    });
    expect(badAccess.json().error.code).toBe("PROJECT_ACCESS_INVALID");
  });
});
