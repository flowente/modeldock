import type { FastifyInstance, FastifyRequest } from "fastify";
import { can, type ApiKeyService } from "@modeldock/auth";
import type { AuditStore } from "@modeldock/core";
import { requireAccount, requirePermission } from "./auth-routes.ts";

export interface ApiKeysRoutesOptions {
  apiKeys: ApiKeyService;
  auditStore: AuditStore;
}

/**
 * Managing API keys happens from a signed-in browser session. A key cannot manage keys:
 * it only opens the OpenAI-compatible endpoints.
 */
export function registerApiKeysRoutes(app: FastifyInstance, options: ApiKeysRoutesOptions): void {
  const { apiKeys, auditStore } = options;

  const audit = (request: FastifyRequest, action: string, resourceId: string) =>
    auditStore.append({
      actorId: request.account?.id ?? "anonymous",
      action,
      module: "api-keys",
      result: "success",
      correlationId: request.id,
      resourceType: "api-key",
      resourceId
    });

  app.get<{ Querystring: { scope?: string } }>("/api/api-keys", async (request) => {
    if (request.query.scope === "all") {
      requirePermission(request, "accounts:manage");
      return apiKeys.listAll();
    }
    return apiKeys.listOwn(requireAccount(request));
  });

  app.post<{ Body: { name?: string } }>("/api/api-keys", async (request, reply) => {
    const account = requireAccount(request);
    const created = await apiKeys.create({ account, name: String(request.body?.name ?? "") });
    await audit(request, "API_KEY_CREATED", created.key.id);
    return reply.status(201).send(created);
  });

  app.delete<{ Params: { id: string } }>("/api/api-keys/:id", async (request, reply) => {
    const account = requireAccount(request);
    await apiKeys.revoke({ id: request.params.id, actor: account, canManageAll: can(account.role, "accounts:manage") });
    await audit(request, "API_KEY_REVOKED", request.params.id);
    return reply.status(204).send();
  });
}
