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
  const app = await buildApp({ ollamaMode: "fake", ollamaGateway: gateway });
  apps.push(app);
  const adminCookie = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/setup", payload: admin }));
  const invite = await app.inject({ method: "POST", url: "/api/invitations", headers: { cookie: adminCookie }, payload: { email: "anna@example.com", displayName: "Anna" } });
  const memberCookie = cookieFrom(await app.inject({ method: "POST", url: `/api/auth/invitations/${invite.json().token}/accept`, payload: { password: "password-di-anna" } }));
  return { app, gateway, adminCookie, memberCookie };
}

type View = { id: string; name: string; shared: boolean; editable: boolean; instruction: string };
const list = async (app: FastifyInstance, cookie: string) => (await app.inject({ method: "GET", url: "/api/chat/commands", headers: { cookie } })).json() as View[];

describe("quick commands", () => {
  it("everyone starts with the shared commands; only administrators may change them", async () => {
    const { app, adminCookie, memberCookie } = await start();
    const forMember = await list(app, memberCookie);
    expect(forMember.map((command) => command.name)).toEqual(["correggi", "email", "inglese", "italiano", "riassumi", "spiega"]);
    expect(forMember.every((command) => command.shared && !command.editable)).toBe(true);
    expect((await list(app, adminCookie)).every((command) => command.editable)).toBe(true);

    const riassumi = forMember.find((command) => command.name === "riassumi")!;
    const edit = { name: "riassumi", description: "x", instruction: "y" };
    expect((await app.inject({ method: "PUT", url: `/api/chat/commands/${riassumi.id}`, headers: { cookie: memberCookie }, payload: edit })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/chat/commands/${riassumi.id}`, headers: { cookie: memberCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/chat/commands", headers: { cookie: memberCookie }, payload: { ...edit, name: "nuovo", shared: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/api/chat/commands/${riassumi.id}`, headers: { cookie: adminCookie }, payload: { ...edit, description: "Più corto" } })).statusCode).toBe(200);
  });

  it("a personal command is seen and used only by its owner", async () => {
    const { app, adminCookie, memberCookie } = await start();
    const created = await app.inject({
      method: "POST",
      url: "/api/chat/commands",
      headers: { cookie: memberCookie },
      payload: { name: "/Haiku", description: "In tre versi", instruction: "Rispondi con un haiku." }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "haiku", shared: false, editable: true });
    expect((await list(app, adminCookie)).some((command) => command.name === "haiku")).toBe(false);
    expect((await app.inject({ method: "DELETE", url: `/api/chat/commands/${created.json().id}`, headers: { cookie: adminCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/chat/commands/${created.json().id}`, headers: { cookie: memberCookie } })).statusCode).toBe(204);
  });

  it("refuses bad names and names already taken", async () => {
    const { app, memberCookie } = await start();
    const post = (name: string) =>
      app.inject({ method: "POST", url: "/api/chat/commands", headers: { cookie: memberCookie }, payload: { name, description: "", instruction: "x" } });
    expect((await post("due parole")).json().error.code).toBe("QUICK_COMMAND_NAME_INVALID");
    expect((await post("riassumi")).json().error.code).toBe("QUICK_COMMAND_NAME_TAKEN");
    expect((await post("mio")).statusCode).toBe(201);
    expect((await post("mio")).json().error.code).toBe("QUICK_COMMAND_NAME_TAKEN");
  });

  it("the instruction reaches the model with that message only, and the message remembers the command", async () => {
    const { app, gateway, adminCookie } = await start();
    const riassumi = (await list(app, adminCookie)).find((command) => command.name === "riassumi")!;
    const first = await app.inject({
      method: "POST",
      url: "/api/chat/messages",
      headers: { cookie: adminCookie },
      payload: { model: "llama3.1:8b", content: "Un testo lungo da accorciare", commandId: riassumi.id }
    });
    expect(gateway.lastChatInput?.messages.slice(-2)).toEqual([
      { role: "system", content: riassumi.instruction },
      { role: "user", content: "Un testo lungo da accorciare" }
    ]);

    const conversationId = JSON.parse(first.body.split("\n")[0]!).conversation.id as string;
    await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "llama3.1:8b", content: "grazie", conversationId } });
    expect(gateway.lastChatInput?.messages.some((message) => message.role === "system")).toBe(false);

    const saved = (await app.inject({ method: "GET", url: `/api/chat/conversations/${conversationId}`, headers: { cookie: adminCookie } })).json();
    expect(saved.messages[0]).toMatchObject({ role: "user", command: "riassumi", content: "Un testo lungo da accorciare" });
    expect(saved.messages[2]).not.toHaveProperty("command");
  });

  it("someone else's command cannot be used, and nothing is saved", async () => {
    const { app, adminCookie, memberCookie } = await start();
    const mine = (await app.inject({ method: "POST", url: "/api/chat/commands", headers: { cookie: memberCookie }, payload: { name: "segreto", instruction: "x" } })).json();
    const attempt = await app.inject({ method: "POST", url: "/api/chat/messages", headers: { cookie: adminCookie }, payload: { model: "llama3.1:8b", content: "ciao", commandId: mine.id } });
    expect(attempt.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/chat/conversations", headers: { cookie: adminCookie } })).json()).toEqual([]);
  });
});
