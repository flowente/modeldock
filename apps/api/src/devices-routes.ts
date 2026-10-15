import type { FastifyInstance, FastifyRequest } from "fastify";
import { can } from "@modeldock/auth";
import type { Account, AuditStore, Clock } from "@modeldock/core";
import { ModelDockError } from "@modeldock/core";
import { buildInviteLink, listLanAddresses, ONLINE_WINDOW_MS, type LinkRegistry, type LinkTarget, type RunningLinkServer, type ServerIdentity } from "@modeldock/link";

/** The running device connection, as the API sees it. */
export interface LinkRuntime {
  identity: ServerIdentity;
  registry: LinkRegistry;
  server: RunningLinkServer;
  allowUnpairedBrowsers: boolean;
}

export interface DevicesRoutesOptions {
  link: LinkRuntime | null;
  auditStore: AuditStore;
  clock: Clock;
}

/** Where other devices find this server: every local network address, on the connection's port. */
export function linkHosts(link: LinkRuntime): LinkTarget[] {
  return listLanAddresses().map((host) => ({ host, port: link.server.port }));
}

export function registerDevicesRoutes(app: FastifyInstance, options: DevicesRoutesOptions): void {
  const { auditStore, clock } = options;

  function requireLink(request: FastifyRequest): { account: Account; link: LinkRuntime } {
    const account = request.account;
    if (!account) {
      throw new ModelDockError({ code: "AUTH_REQUIRED", module: "devices", message: "Sign in to continue.", httpStatus: 401 });
    }
    if (!can(account.role, "accounts:manage")) {
      throw new ModelDockError({ code: "AUTH_FORBIDDEN", module: "devices", message: "Your account cannot do this.", httpStatus: 403 });
    }
    if (!options.link) {
      throw new ModelDockError({
        code: "LINK_DISABLED",
        module: "devices",
        message: "The connection between devices is switched off on this server.",
        httpStatus: 409
      });
    }
    return { account, link: options.link };
  }

  const audit = (request: FastifyRequest, action: string, resourceId?: string) =>
    auditStore.append({
      actorId: request.account?.id ?? "anonymous",
      action,
      module: "devices",
      result: "success",
      correlationId: request.id,
      resourceType: "device",
      ...(resourceId ? { resourceId } : {})
    });

  app.get("/api/devices", async (request) => {
    const { link } = requireLink(request);
    const now = clock.now().getTime();
    const devices = await link.registry.listDevices();
    const invites = await link.registry.listInvites();
    return {
      connection: {
        port: link.server.port,
        hosts: linkHosts(link),
        fingerprint: link.identity.fingerprint,
        allowUnpairedBrowsers: link.allowUnpairedBrowsers
      },
      devices: devices.map((device) => {
        const last = link.server.lastActivity.get(device.id);
        return { ...device, online: last !== undefined && now - last < ONLINE_WINDOW_MS };
      }),
      invites: invites.filter((invite) => !invite.revoked && (invite.reusable || invite.uses === 0) && Date.parse(invite.expiresAt) > now)
    };
  });

  app.post<{ Body: { requirePin?: boolean; reusable?: boolean; hours?: number; preauthorized?: boolean } }>("/api/devices/invites", async (request, reply) => {
    const { link } = requireLink(request);
    const hosts = linkHosts(link);
    if (hosts.length === 0) {
      throw new ModelDockError({
        code: "LINK_NO_NETWORK",
        module: "devices",
        message: "This computer is not on a local network, so no device could reach it.",
        httpStatus: 409
      });
    }
    const hours = typeof request.body?.hours === "number" ? request.body.hours : 24;
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
      throw new ModelDockError({ code: "INVITATION_TTL_INVALID", module: "devices", message: "An invitation lasts between one hour and 30 days.", httpStatus: 400 });
    }
    const created = await link.registry.createInvite({
      ttlSeconds: Math.round(hours * 3600),
      requirePin: request.body?.requirePin === true,
      reusable: request.body?.reusable === true,
      preauthorized: request.body?.preauthorized === true
    });
    await audit(request, "DEVICE_INVITE_CREATED", created.invite.id);
    return reply.status(201).send({
      invite: created.invite,
      // Shown once: the secret lives only in this link.
      link: buildInviteLink({ hosts, inviteId: created.invite.id, secret: created.secret, fingerprint: link.identity.fingerprint }),
      ...(created.pin ? { pin: created.pin } : {})
    });
  });

  app.delete<{ Params: { id: string } }>("/api/devices/invites/:id", async (request, reply) => {
    const { link } = requireLink(request);
    await link.registry.revokeInvite(request.params.id);
    await audit(request, "DEVICE_INVITE_REVOKED", request.params.id);
    return reply.status(204).send();
  });

  app.patch<{ Params: { id: string }; Body: { authorized?: boolean } }>("/api/devices/:id", async (request) => {
    const { link } = requireLink(request);
    if (typeof request.body?.authorized !== "boolean") {
      throw new ModelDockError({ code: "INVALID_INPUT", module: "devices", message: "Say whether the device is authorized.", httpStatus: 400 });
    }
    const device = await link.registry.setAuthorization(request.params.id, request.body.authorized).catch((error: unknown) => {
      throw new ModelDockError({ code: "DEVICE_NOT_FOUND", module: "devices", message: "Device not found.", httpStatus: 404, cause: error });
    });
    await audit(request, request.body.authorized ? "DEVICE_APPROVED" : "DEVICE_BLOCKED", device.id);
    return device;
  });

  app.delete<{ Params: { id: string } }>("/api/devices/:id", async (request, reply) => {
    const { link } = requireLink(request);
    await link.registry.removeDevice(request.params.id).catch((error: unknown) => {
      throw new ModelDockError({ code: "DEVICE_NOT_FOUND", module: "devices", message: "Device not found.", httpStatus: 404, cause: error });
    });
    await audit(request, "DEVICE_REMOVED", request.params.id);
    return reply.status(204).send();
  });
}
