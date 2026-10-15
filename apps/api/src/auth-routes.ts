import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { can, type AccountService, type IssuedSession, type Permission } from "@modeldock/auth";
import type { Account, AuditStore, Clock, ModelAccessStore, Role } from "@modeldock/core";
import { ModelDockError } from "@modeldock/core";

export const SESSION_COOKIE = "modeldock_session";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 10;

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in account, or null. Set on every request from the session cookie. */
    account: Account | null;
    sessionIdHash: string | null;
  }
}

export interface AccountRoutesOptions {
  accounts: AccountService;
  auditStore: AuditStore;
  modelAccess: ModelAccessStore;
  clock: Clock;
  /**
   * When true, every API route except the public ones needs a signed-in account.
   * Off until the web app has its login screen (phase 3): turning it on earlier
   * would lock the current dashboard out of its own API.
   */
  requireLogin: boolean;
}

/** Reachable without an account: health, the login flow and invitation links. */
function isPublicRoute(path: string): boolean {
  return path === "/api/health";
}

/** What a signed-in account needs for the routes that existed before accounts. */
function permissionForLegacyRoute(method: string, path: string): Permission | "operate" {
  if (path.startsWith("/api/access")) return method === "GET" ? "system:read" : "accounts:manage";
  if (method === "GET" || method === "HEAD") return "system:read";
  return "operate";
}

export function registerAccountRoutes(app: FastifyInstance, options: AccountRoutesOptions): void {
  const { accounts, auditStore, modelAccess } = options;
  const failedLogins = new Map<string, number[]>();

  app.decorateRequest("account", null);
  app.decorateRequest("sessionIdHash", null);

  app.addHook("onRequest", async (request, reply) => {
    const session = await accounts.authenticate(readCookie(request, SESSION_COOKIE));
    request.account = session?.account ?? null;
    request.sessionIdHash = session?.idHash ?? null;

    const path = request.url.split("?")[0] ?? "";
    if (!options.requireLogin || !path.startsWith("/api/") || isPublicRoute(path) || isAccountRoute(path)) {
      return;
    }
    if (!request.account) {
      return sendError(reply, request, 401, "AUTH_REQUIRED", "Sign in to continue.");
    }
    const needed = permissionForLegacyRoute(request.method, path);
    const allowed = needed === "operate" ? ["admin", "operator"].includes(request.account.role) : can(request.account.role, needed);
    if (!allowed) {
      return sendError(reply, request, 403, "AUTH_FORBIDDEN", "Your account cannot do this.");
    }
  });

  const audit = (request: FastifyRequest, action: string, result: "success" | "failure", resourceType?: string, resourceId?: string) =>
    auditStore.append({
      actorId: request.account?.id ?? "anonymous",
      action,
      module: "accounts",
      result,
      correlationId: request.id,
      ...(resourceType ? { resourceType } : {}),
      ...(resourceId ? { resourceId } : {})
    });

  const startSession = (request: FastifyRequest, reply: FastifyReply, session: IssuedSession) => {
    reply.header("set-cookie", sessionCookie(request, session.token, session.expiresAt, options.clock.now()));
    return { account: session.account, expiresAt: session.expiresAt };
  };

  // ---- Public: state, first setup, login, logout, invitation links ----

  app.get("/api/auth/state", async (request) => ({
    setupRequired: await accounts.needsSetup(),
    requireLogin: options.requireLogin,
    account: request.account
  }));

  app.post<{ Body: { email?: string; displayName?: string; password?: string } }>("/api/auth/setup", async (request, reply) => {
    const body = request.body ?? {};
    const session = await accounts.setupFirstAdmin({
      email: String(body.email ?? ""),
      displayName: String(body.displayName ?? ""),
      password: String(body.password ?? ""),
      ...userAgent(request)
    });
    request.account = session.account;
    await audit(request, "ACCOUNT_SETUP_COMPLETED", "success", "account", session.account.id);
    return reply.status(201).send(startSession(request, reply, session));
  });

  app.post<{ Body: { email?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
    const key = request.ip;
    const now = Date.now();
    const recent = (failedLogins.get(key) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
    if (recent.length >= MAX_FAILED_LOGINS) {
      throw new ModelDockError({
        code: "AUTH_RATE_LIMITED",
        module: "accounts",
        message: "Too many failed attempts. Try again in a few minutes.",
        httpStatus: 429
      });
    }
    try {
      const session = await accounts.login({
        email: String(request.body?.email ?? ""),
        password: String(request.body?.password ?? ""),
        ...userAgent(request)
      });
      failedLogins.delete(key);
      request.account = session.account;
      await audit(request, "ACCOUNT_LOGIN", "success", "account", session.account.id);
      return reply.send(startSession(request, reply, session));
    } catch (error) {
      recent.push(now);
      failedLogins.set(key, recent);
      await audit(request, "ACCOUNT_LOGIN", "failure");
      throw error;
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await accounts.logout(readCookie(request, SESSION_COOKIE));
    reply.header("set-cookie", clearedCookie(request));
    return reply.status(204).send();
  });

  app.get<{ Params: { token: string } }>("/api/auth/invitations/:token", async (request) => accounts.previewInvitation(request.params.token));

  app.post<{ Params: { token: string }; Body: { password?: string } }>("/api/auth/invitations/:token/accept", async (request, reply) => {
    const session = await accounts.acceptInvitation({
      token: request.params.token,
      password: String(request.body?.password ?? ""),
      ...userAgent(request)
    });
    request.account = session.account;
    await audit(request, "INVITATION_ACCEPTED", "success", "account", session.account.id);
    return reply.status(201).send(startSession(request, reply, session));
  });

  // ---- Signed in: own account ----

  app.get("/api/auth/me", async (request) => requireAccount(request));

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>("/api/auth/password", async (request, reply) => {
    const account = requireAccount(request);
    await accounts.changePassword({
      accountId: account.id,
      currentPassword: String(request.body?.currentPassword ?? ""),
      newPassword: String(request.body?.newPassword ?? ""),
      ...(request.sessionIdHash ? { keepSessionIdHash: request.sessionIdHash } : {})
    });
    await audit(request, "ACCOUNT_PASSWORD_CHANGED", "success", "account", account.id);
    return reply.status(204).send();
  });

  // ---- Administrators: accounts, groups, invitations, per-account grants ----

  app.get("/api/users", async (request) => {
    requirePermission(request, "accounts:manage");
    return accounts.listAccounts();
  });

  app.patch<{ Params: { id: string }; Body: { displayName?: string; role?: Role; status?: "active" | "disabled"; groupIds?: string[] } }>(
    "/api/users/:id",
    async (request) => {
      requirePermission(request, "accounts:manage");
      const body = request.body ?? {};
      const updated = await accounts.updateAccount(request.params.id, {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.status === "active" || body.status === "disabled" ? { status: body.status } : {}),
        ...(Array.isArray(body.groupIds) ? { groupIds: body.groupIds.map(String) } : {})
      });
      await audit(request, "ACCOUNT_UPDATED", "success", "account", updated.id);
      return updated;
    }
  );

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (request, reply) => {
    const actor = requirePermission(request, "accounts:manage");
    if (actor.id === request.params.id) {
      throw new ModelDockError({ code: "ACCOUNT_DELETE_SELF", module: "accounts", message: "You cannot delete your own account.", httpStatus: 409 });
    }
    await accounts.deleteAccount(request.params.id);
    await audit(request, "ACCOUNT_DELETED", "success", "account", request.params.id);
    return reply.status(204).send();
  });

  app.get("/api/groups", async (request) => {
    requirePermission(request, "accounts:manage");
    return accounts.listGroups();
  });

  app.post<{ Body: { name?: string; description?: string } }>("/api/groups", async (request, reply) => {
    requirePermission(request, "accounts:manage");
    const group = await accounts.createGroup({
      name: String(request.body?.name ?? ""),
      ...(request.body?.description ? { description: String(request.body.description) } : {})
    });
    await audit(request, "GROUP_CREATED", "success", "group", group.id);
    return reply.status(201).send(group);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string | null } }>("/api/groups/:id", async (request) => {
    requirePermission(request, "accounts:manage");
    const group = await accounts.updateGroup(request.params.id, {
      ...(request.body?.name !== undefined ? { name: String(request.body.name) } : {}),
      ...(request.body?.description !== undefined ? { description: request.body.description } : {})
    });
    await audit(request, "GROUP_UPDATED", "success", "group", group.id);
    return group;
  });

  app.delete<{ Params: { id: string } }>("/api/groups/:id", async (request, reply) => {
    requirePermission(request, "accounts:manage");
    await accounts.deleteGroup(request.params.id);
    await audit(request, "GROUP_DELETED", "success", "group", request.params.id);
    return reply.status(204).send();
  });

  app.get("/api/invitations", async (request) => {
    requirePermission(request, "accounts:manage");
    return accounts.listInvitations();
  });

  app.post<{ Body: { email?: string; displayName?: string; role?: Role; groupIds?: string[]; ttlHours?: number } }>(
    "/api/invitations",
    async (request, reply) => {
      const actor = requirePermission(request, "accounts:manage");
      const body = request.body ?? {};
      const created = await accounts.createInvitation({
        email: String(body.email ?? ""),
        displayName: String(body.displayName ?? ""),
        ...(body.role ? { role: body.role } : {}),
        ...(Array.isArray(body.groupIds) ? { groupIds: body.groupIds.map(String) } : {}),
        ...(typeof body.ttlHours === "number" ? { ttlHours: body.ttlHours } : {}),
        createdBy: actor.id
      });
      await audit(request, "INVITATION_CREATED", "success", "invitation", created.invitation.id);
      // The token is shown here once. The web app turns it into the link the person opens.
      return reply.status(201).send({ invitation: created.invitation, token: created.token, acceptPath: `/#/invito/${created.token}` });
    }
  );

  app.delete<{ Params: { id: string } }>("/api/invitations/:id", async (request, reply) => {
    requirePermission(request, "accounts:manage");
    await accounts.revokeInvitation(request.params.id);
    await audit(request, "INVITATION_REVOKED", "success", "invitation", request.params.id);
    return reply.status(204).send();
  });

  app.put<{ Params: { modelName: string; userId: string }; Body: { canUse?: boolean } }>(
    "/api/access/model-policies/:modelName/users/:userId",
    async (request) => {
      requirePermission(request, "accounts:manage");
      const policy = await modelAccess.setUserGrant(request.params.modelName, request.params.userId, request.body?.canUse === true);
      await audit(request, "MODEL_ACCESS_USER_GRANT_UPDATED", "success", "model", request.params.modelName);
      return policy;
    }
  );
}

/**
 * Account routes check their own permissions (public, signed in, or administrator),
 * so the gate for the older dashboard routes leaves them alone.
 */
function isAccountRoute(path: string): boolean {
  return ["/api/auth", "/api/users", "/api/groups", "/api/invitations"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ||
    /^\/api\/access\/model-policies\/[^/]+\/users\//.test(path);
}

function requireAccount(request: FastifyRequest): Account {
  if (!request.account) {
    throw new ModelDockError({ code: "AUTH_REQUIRED", module: "accounts", message: "Sign in to continue.", httpStatus: 401 });
  }
  return request.account;
}

function requirePermission(request: FastifyRequest, permission: Permission): Account {
  const account = requireAccount(request);
  if (!can(account.role, permission)) {
    throw new ModelDockError({ code: "AUTH_FORBIDDEN", module: "accounts", message: "Your account cannot do this.", httpStatus: 403 });
  }
  return account;
}

async function sendError(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message, module: "accounts", correlationId: request.id } });
}

function userAgent(request: FastifyRequest): { userAgent?: string } {
  const value = request.headers["user-agent"];
  return typeof value === "string" ? { userAgent: value } : {};
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Secure only when the request really arrived over HTTPS: on plain localhost the cookie would be dropped. */
function isHttps(request: FastifyRequest): boolean {
  return request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
}

function sessionCookie(request: FastifyRequest, token: string, expiresAt: string, now: Date): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000));
  return [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`, ...(isHttps(request) ? ["Secure"] : [])].join("; ");
}

function clearedCookie(request: FastifyRequest): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", ...(isHttps(request) ? ["Secure"] : [])].join("; ");
}
