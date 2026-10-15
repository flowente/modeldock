import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { can } from "@modeldock/auth";
import type { Account, ChatMessage, ChatStore, ChatTurn, Clock, Conversation, ModelAccessStore, OllamaGateway } from "@modeldock/core";
import { canUseModel, ModelDockError } from "@modeldock/core";

/** How many earlier messages go back to the model. Older ones are left out to fit its context. */
const HISTORY_LIMIT = 40;
const MAX_MESSAGE_LENGTH = 32_000;
const TITLE_LENGTH = 60;

export interface ChatRoutesOptions {
  chats: ChatStore;
  ollama: OllamaGateway;
  modelAccess: ModelAccessStore;
  clock: Clock;
}

/** One line of the reply stream (newline-delimited JSON). */
export type ChatStreamEvent =
  | { type: "conversation"; conversation: Conversation }
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; content: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; error: { code: string; message: string }; message?: ChatMessage };

export function registerChatRoutes(app: FastifyInstance, options: ChatRoutesOptions): void {
  const { chats, ollama, modelAccess, clock } = options;
  // What a model can do never changes for a given name and tag: ask Ollama once.
  const capabilities = new Map<string, Promise<string[]>>();

  async function canChat(name: string): Promise<boolean> {
    let known = capabilities.get(name);
    if (!known) {
      known = ollama.getModelCapabilities(name).catch(() => {
        capabilities.delete(name);
        return [];
      });
      capabilities.set(name, known);
    }
    const list = await known;
    // An Ollama too old to report capabilities gets the benefit of the doubt.
    return list.length === 0 || list.includes("completion");
  }

  /** The models this account may chat with: installed, able to chat, enabled and granted. */
  async function allowedModels(account: Account) {
    const installed = await ollama.listLocalModels();
    const user = { userId: account.id, role: account.role, groupIds: account.groupIds };
    const result = [];
    for (const model of installed) {
      if (!(await canChat(model.name))) continue;
      const policy = await modelAccess.ensurePolicy(model.name);
      if (canUseModel(policy, user)) result.push({ name: model.name, sizeBytes: model.sizeBytes });
    }
    return result;
  }

  async function ownConversation(account: Account, id: string): Promise<Conversation> {
    const conversation = await chats.findConversation(id);
    // Someone else's conversation answers exactly like a missing one.
    if (!conversation || conversation.userId !== account.id) {
      throw new ModelDockError({ code: "CHAT_NOT_FOUND", module: "chat", message: "Conversation not found.", httpStatus: 404 });
    }
    return conversation;
  }

  app.get("/api/chat/models", async (request) => allowedModels(requireChatAccount(request)));

  app.get<{ Querystring: { q?: string } }>("/api/chat/conversations", async (request) => {
    const account = requireChatAccount(request);
    return chats.listConversations(account.id, request.query.q);
  });

  app.get<{ Params: { id: string } }>("/api/chat/conversations/:id", async (request) => {
    const account = requireChatAccount(request);
    const conversation = await ownConversation(account, request.params.id);
    return { conversation, messages: await chats.listMessages(conversation.id) };
  });

  app.patch<{ Params: { id: string }; Body: { title?: string } }>("/api/chat/conversations/:id", async (request) => {
    const account = requireChatAccount(request);
    const conversation = await ownConversation(account, request.params.id);
    const title = cleanTitle(String(request.body?.title ?? ""));
    if (!title) {
      throw new ModelDockError({ code: "CHAT_TITLE_INVALID", module: "chat", message: "The title cannot be empty.", httpStatus: 400 });
    }
    await chats.updateConversation(conversation.id, { title, updatedAt: conversation.updatedAt });
    return { ...conversation, title };
  });

  app.delete<{ Params: { id: string } }>("/api/chat/conversations/:id", async (request, reply) => {
    const account = requireChatAccount(request);
    const conversation = await ownConversation(account, request.params.id);
    await chats.deleteConversation(conversation.id);
    return reply.status(204).send();
  });

  /**
   * Sends a message and streams the reply as newline-delimited JSON.
   * Without `conversationId` a new conversation starts, titled from the message.
   * Closing the request (the stop button) stops the model; what was written so far is kept.
   */
  app.post<{ Body: { conversationId?: string; model?: string; content?: string } }>("/api/chat/messages", async (request, reply) => {
    const account = requireChatAccount(request);
    const content = String(request.body?.content ?? "").trim();
    const model = String(request.body?.model ?? "").trim();

    if (!content || content.length > MAX_MESSAGE_LENGTH) {
      throw new ModelDockError({ code: "CHAT_MESSAGE_INVALID", module: "chat", message: "The message is empty or too long.", httpStatus: 400 });
    }
    if (!(await allowedModels(account)).some((allowed) => allowed.name === model)) {
      // An unknown model and a forbidden one look the same from outside.
      throw new ModelDockError({ code: "CHAT_MODEL_NOT_ALLOWED", module: "chat", message: "This model is not available to your account.", httpStatus: 403 });
    }

    const now = clock.now().toISOString();
    let conversation: Conversation;
    let isNew = false;
    if (request.body?.conversationId) {
      conversation = await ownConversation(account, request.body.conversationId);
    } else {
      conversation = { id: `cnv_${randomUUID()}`, userId: account.id, title: cleanTitle(content), model, createdAt: now, updatedAt: now };
      await chats.insertConversation(conversation);
      isNew = true;
    }

    const history = (await chats.listMessages(conversation.id)).filter((message) => message.content.length > 0).slice(-HISTORY_LIMIT);
    const userMessage: ChatMessage = { id: `msg_${randomUUID()}`, conversationId: conversation.id, role: "user", content, status: "complete", createdAt: now };
    await chats.insertMessage(userMessage);
    await chats.updateConversation(conversation.id, { model, updatedAt: now });

    const turns: ChatTurn[] = [...history.map((message) => ({ role: message.role, content: message.content })), { role: "user", content }];

    // From here the reply is a stream: errors travel inside it, not as an HTTP status.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-correlation-id": request.id
    });
    const send = (event: ChatStreamEvent) => {
      if (!raw.writableEnded) raw.write(`${JSON.stringify(event)}\n`);
    };

    const stop = new AbortController();
    const onClose = () => stop.abort();
    raw.on("close", onClose);

    if (isNew) send({ type: "conversation", conversation: { ...conversation, model } });
    send({ type: "message", message: userMessage });

    let answer = "";
    let failure: { code: string; message: string } | undefined;
    try {
      for await (const chunk of ollama.chat({ model, messages: turns, signal: stop.signal })) {
        if (stop.signal.aborted) break;
        if (chunk.content) {
          answer += chunk.content;
          send({ type: "delta", content: chunk.content });
        }
        if (chunk.done) break;
      }
    } catch (error) {
      if (!stop.signal.aborted) {
        failure = {
          code: error instanceof ModelDockError ? error.code : "CHAT_MODEL_FAILED",
          message: error instanceof Error ? error.message : "The model stopped unexpectedly."
        };
        request.log.error({ error }, "Chat reply failed");
      }
    } finally {
      raw.off("close", onClose);
    }

    const assistantMessage: ChatMessage = {
      id: `msg_${randomUUID()}`,
      conversationId: conversation.id,
      role: "assistant",
      content: answer,
      model,
      status: failure ? "error" : stop.signal.aborted ? "stopped" : "complete",
      createdAt: clock.now().toISOString()
    };
    await chats.insertMessage(assistantMessage);
    await chats.updateConversation(conversation.id, { updatedAt: assistantMessage.createdAt });

    if (stop.signal.aborted) {
      // The other side is gone: ending politely would leave the socket open, so drop it.
      raw.destroy();
      return;
    }
    send(failure ? { type: "error", error: failure, message: assistantMessage } : { type: "done", message: assistantMessage });
    if (!raw.writableEnded) raw.end();
  });
}

function requireChatAccount(request: FastifyRequest): Account {
  const account = request.account;
  if (!account) {
    throw new ModelDockError({ code: "AUTH_REQUIRED", module: "chat", message: "Sign in to continue.", httpStatus: 401 });
  }
  if (!can(account.role, "chat:use")) {
    throw new ModelDockError({ code: "AUTH_FORBIDDEN", module: "chat", message: "Your account cannot chat.", httpStatus: 403 });
  }
  return account;
}

/** First line of the first message, shortened: the conversation's name until someone renames it. */
function cleanTitle(value: string): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
}
