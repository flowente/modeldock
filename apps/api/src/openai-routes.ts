import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyService } from "@modeldock/auth";
import type { Account, ModelAccessStore, OllamaGateway, OpenAiEndpoint } from "@modeldock/core";
import { canUseModel, ModelDockError } from "@modeldock/core";

/** Long conversations, or many texts to embed at once, are bigger than Fastify's 1 MB default. */
const BODY_LIMIT = 32 * 1024 * 1024;

export interface OpenAiRoutesOptions {
  apiKeys: ApiKeyService;
  ollama: OllamaGateway;
  modelAccess: ModelAccessStore;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The API key that authenticated a /v1 request. */
    apiKeyId: string | null;
  }
}

/**
 * The OpenAI-compatible API, so that tools written for OpenAI work by changing only the
 * address and the key. ModelDock checks the key and the model; Ollama does the rest.
 * Calls here never end up in the chat history.
 */
export function registerOpenAiRoutes(app: FastifyInstance, options: OpenAiRoutesOptions): void {
  const { apiKeys, ollama, modelAccess } = options;
  app.decorateRequest("apiKeyId", null);

  app.register(
    async (scope) => {
      // Errors in the shape OpenAI clients know how to read.
      scope.setErrorHandler(async (error, request, reply) => {
        if (error instanceof ModelDockError) {
          return sendOpenAiError(reply, error.httpStatus, error.message, error.code);
        }
        const status = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
        if (status < 500) return sendOpenAiError(reply, status, error instanceof Error ? error.message : "Invalid request.", "invalid_request");
        request.log.error({ error }, "OpenAI-compatible API error");
        return sendOpenAiError(reply, 500, "Unexpected ModelDock error.", "internal_error");
      });

      scope.setNotFoundHandler(async (request, reply) =>
        sendOpenAiError(reply, 404, `Unknown endpoint: ${request.method} ${request.url.split("?")[0]}.`, "unknown_endpoint")
      );

      // Only a key opens these routes. A browser session does not: it would let any page the
      // signed-in person visits spend their models.
      scope.addHook("onRequest", async (request) => {
        request.account = null;
        const header = request.headers.authorization;
        const secret = typeof header === "string" && /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : undefined;
        if (!secret) {
          throw openAiError(401, "Missing API key. Send it as: Authorization: Bearer mdk_…", "missing_api_key");
        }
        const authenticated = await apiKeys.authenticate(secret);
        if (!authenticated) {
          throw openAiError(401, "Invalid API key. It may have been revoked.", "invalid_api_key");
        }
        request.account = authenticated.account;
        request.apiKeyId = authenticated.keyId;
      });

      scope.get("/models", async (request) => ({
        object: "list",
        data: (await allowedModels(request.account!)).map(toOpenAiModel)
      }));

      scope.get<{ Params: { "*": string } }>("/models/*", async (request) => {
        const name = request.params["*"];
        const model = (await allowedModels(request.account!)).find((candidate) => candidate.name === name);
        if (!model) throw modelNotFound(name);
        return toOpenAiModel(model);
      });

      scope.post("/chat/completions", { bodyLimit: BODY_LIMIT }, async (request, reply) => forward(request, reply, "/v1/chat/completions"));
      scope.post("/embeddings", { bodyLimit: BODY_LIMIT }, async (request, reply) => forward(request, reply, "/v1/embeddings"));
    },
    { prefix: "/v1" }
  );

  /** Installed, enabled and granted to this account. Embedding models included. */
  async function allowedModels(account: Account) {
    const installed = await ollama.listLocalModels();
    const user = { userId: account.id, role: account.role, groupIds: account.groupIds };
    const result = [];
    for (const model of installed) {
      if (canUseModel(await modelAccess.ensurePolicy(model.name), user)) result.push(model);
    }
    return result;
  }

  async function forward(request: FastifyRequest, reply: FastifyReply, endpoint: OpenAiEndpoint) {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw openAiError(400, "The request body must be a JSON object.", "invalid_request");
    }
    const payload = body as Record<string, unknown>;
    const model = typeof payload.model === "string" ? payload.model.trim() : "";
    if (!model) throw openAiError(400, "You must provide a model parameter.", "missing_model");
    // A model the account may not use answers exactly like one that does not exist.
    if (!(await allowedModels(request.account!)).some((candidate) => candidate.name === model)) throw modelNotFound(model);

    const stop = new AbortController();
    const upstream = await ollama.openAi({ endpoint, body: payload, signal: stop.signal });

    // From here the answer is passed through as it arrives.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(upstream.status, {
      "content-type": upstream.contentType,
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-correlation-id": request.id
    });
    const onClose = () => {
      if (!raw.writableFinished) stop.abort();
    };
    raw.on("close", onClose);
    try {
      for await (const chunk of upstream.body) {
        if (stop.signal.aborted) break;
        raw.write(chunk);
      }
    } catch (error) {
      if (!stop.signal.aborted) request.log.error({ error }, "Forwarding to Ollama failed");
    } finally {
      raw.off("close", onClose);
    }
    if (stop.signal.aborted) {
      // The caller went away: ending politely would leave the socket open, so drop it.
      raw.destroy();
      return;
    }
    raw.end();
  }
}

function toOpenAiModel(model: { name: string; modifiedAt?: string }) {
  const modified = model.modifiedAt ? Date.parse(model.modifiedAt) : Number.NaN;
  return {
    id: model.name,
    object: "model",
    created: Number.isNaN(modified) ? 0 : Math.floor(modified / 1000),
    owned_by: "modeldock"
  };
}

function openAiError(httpStatus: number, message: string, code: string): ModelDockError {
  return new ModelDockError({ code, module: "openai-api", message, httpStatus });
}

function modelNotFound(name: string): ModelDockError {
  return openAiError(404, `The model "${name}" does not exist or your key cannot use it.`, "model_not_found");
}

function sendOpenAiError(reply: FastifyReply, status: number, message: string, code: string) {
  const type = status === 401 ? "authentication_error" : status === 404 ? "not_found_error" : status >= 500 ? "server_error" : "invalid_request_error";
  return reply.status(status).send({ error: { message, type, param: null, code } });
}
