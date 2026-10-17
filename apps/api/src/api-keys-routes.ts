import type { FastifyInstance, FastifyRequest } from "fastify";
import { can, type ApiKeyService, type ApiKeySummary } from "@modeldock/auth";
import type { ApiUsageDay, ApiUsageStore, ApiUsageTotals, AuditStore, Clock } from "@modeldock/core";
import { requireAccount, requirePermission } from "./auth-routes.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The period shown next to each key in the list. */
const LIST_PERIOD_DAYS = 30;
const RECENT_CALLS = 25;

export interface ApiKeysRoutesOptions {
  apiKeys: ApiKeyService;
  usage: ApiUsageStore;
  auditStore: AuditStore;
  clock: Clock;
}

/**
 * Managing API keys happens from a signed-in browser session. A key cannot manage keys:
 * it only opens the OpenAI-compatible endpoints.
 */
export function registerApiKeysRoutes(app: FastifyInstance, options: ApiKeysRoutesOptions): void {
  const { apiKeys, usage, auditStore, clock } = options;

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

  const withUsage = async (keys: ApiKeySummary[]) => {
    const since = new Date(clock.now().getTime() - LIST_PERIOD_DAYS * DAY_MS).toISOString();
    const totals = await usage.totalsByKey(
      keys.map((key) => key.id),
      since
    );
    return keys.map((key) => ({ ...key, usage: totals.get(key.id) ?? emptyTotals() }));
  };

  app.get<{ Querystring: { scope?: string } }>("/api/api-keys", async (request) => {
    if (request.query.scope === "all") {
      requirePermission(request, "accounts:manage");
      return withUsage(await apiKeys.listAll());
    }
    return withUsage(await apiKeys.listOwn(requireAccount(request)));
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

  /**
   * One key's usage: totals, day by day, by model, and the latest calls. `offset` is the
   * viewer's distance from UTC in minutes, so that a day ends at their midnight.
   */
  app.get<{ Params: { id: string }; Querystring: { days?: string; offset?: string } }>("/api/api-keys/:id/usage", async (request) => {
    const account = requireAccount(request);
    const key = await apiKeys.findVisible({ id: request.params.id, actor: account, canManageAll: can(account.role, "accounts:manage") });
    const days = clamp(Number(request.query.days ?? 30), 1, 365, 30);
    const offset = clamp(Number(request.query.offset ?? 0), -14 * 60, 14 * 60, 0);
    const now = clock.now();
    const firstDay = localDay(new Date(now.getTime() - (days - 1) * DAY_MS), offset);
    // Local midnight of the first day, back in UTC.
    const since = new Date(Date.parse(`${firstDay}T00:00:00.000Z`) - offset * 60 * 1000).toISOString();

    const [daily, byModel, recent] = await Promise.all([usage.daily(key.id, since, offset), usage.byModel(key.id, since), usage.recent(key.id, RECENT_CALLS)]);
    return {
      key,
      period: { days, since },
      totals: byModel.reduce(addTotals, emptyTotals()),
      daily: fillDays(daily, firstDay, days),
      byModel,
      recent: recent.map(({ keyId: _keyId, ...entry }) => entry)
    };
  });
}

function emptyTotals(): ApiUsageTotals {
  return { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0 };
}

function addTotals(sum: ApiUsageTotals, row: ApiUsageTotals): ApiUsageTotals {
  return {
    calls: sum.calls + row.calls,
    errors: sum.errors + row.errors,
    promptTokens: sum.promptTokens + row.promptTokens,
    completionTokens: sum.completionTokens + row.completionTokens
  };
}

/** Every day of the period, quiet days included, so a chart shows the gaps. */
function fillDays(rows: ApiUsageDay[], firstDay: string, days: number): ApiUsageDay[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const start = Date.parse(`${firstDay}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(start + index * DAY_MS).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, ...emptyTotals() };
  });
}

function localDay(moment: Date, offsetMinutes: number): string {
  return new Date(moment.getTime() + offsetMinutes * 60 * 1000).toISOString().slice(0, 10);
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}
