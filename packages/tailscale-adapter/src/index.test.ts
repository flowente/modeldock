import { describe, expect, it } from "vitest";
import type { Clock } from "@modeldock/core";
import { TailscaleApiGateway } from "./index.js";

const clock: Clock = {
  now: () => new Date("2026-08-29T00:00:00.000Z")
};

describe("Tailscale API gateway", () => {
  it("reports not configured without an API token", async () => {
    const gateway = new TailscaleApiGateway({ clock });

    await expect(gateway.getLocalStatus()).resolves.toMatchObject({
      name: "tailscale",
      status: "not_configured",
      message: "Tailscale API token is not configured"
    });
  });

  it("lists devices from the Tailscale API", async () => {
    const requests: string[] = [];
    const gateway = new TailscaleApiGateway({
      apiToken: "tskey-api-test",
      clock,
      fetchImpl: async (url, init) => {
        requests.push(String(url));
        expect(init?.headers).toMatchObject({ authorization: "Bearer tskey-api-test" });

        return jsonResponse({
          devices: [
            {
              id: "device-1",
              hostname: "modeldock-node",
              addresses: ["100.64.0.10"],
              connectedToControl: true,
              authorized: true,
              os: "windows",
              lastSeen: "2026-08-29T00:00:00.000Z"
            }
          ]
        });
      },
      tailnet: "-"
    });

    await expect(gateway.listDevices()).resolves.toEqual([
      {
        id: "device-1",
        hostname: "modeldock-node",
        addresses: ["100.64.0.10"],
        online: true,
        authorized: true,
        os: "windows",
        lastSeen: "2026-08-29T00:00:00.000Z"
      }
    ]);
    expect(requests).toEqual(["https://api.tailscale.com/api/v2/tailnet/-/devices?fields=all"]);
  });

  it("updates device authorization and reads the updated device back", async () => {
    const methods: string[] = [];
    const gateway = new TailscaleApiGateway({
      apiToken: "tskey-api-test",
      clock,
      fetchImpl: async (_url, init) => {
        methods.push(init?.method ?? "GET");

        if (init?.method === "POST") {
          expect(init.body).toBe(JSON.stringify({ authorized: false }));
          return jsonResponse({});
        }

        return jsonResponse({
          devices: [
            {
              id: "device-1",
              hostname: "modeldock-node",
              addresses: ["100.64.0.10"],
              connectedToControl: true,
              authorized: false
            }
          ]
        });
      }
    });

    await expect(gateway.updateDeviceAuthorization({ deviceId: "device-1", authorized: false })).resolves.toMatchObject({
      id: "device-1",
      authorized: false
    });
    expect(methods).toEqual(["POST", "GET"]);
  });

  it("creates a one-time member invite for the tailnet", async () => {
    const gateway = new TailscaleApiGateway({
      apiToken: "tskey-api-test",
      clock,
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://api.tailscale.com/api/v2/tailnet/-/user-invites");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ role: "member", email: "guest@example.com" });

        return jsonResponse({
          id: "invite-1",
          inviteUrl: "https://login.tailscale.com/uinv/modeldock",
          role: "member",
          email: "guest@example.com"
        });
      }
    });

    await expect(gateway.createUserInvite({ email: " Guest@Example.com " })).resolves.toEqual({
      id: "invite-1",
      inviteUrl: "https://login.tailscale.com/uinv/modeldock",
      role: "member",
      email: "guest@example.com",
      expiresAt: undefined
    });
  });

  it("generates a pre-authorized, tagged, ephemeral auth key for a client invite", async () => {
    const gateway = new TailscaleApiGateway({
      apiToken: "tskey-api-test",
      clock,
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://api.tailscale.com/api/v2/tailnet/-/keys");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          description: "ModelDock client invite",
          expirySeconds: 3600,
          capabilities: {
            devices: {
              create: {
                reusable: false,
                ephemeral: true,
                preauthorized: true,
                tags: ["tag:modeldock-client"]
              }
            }
          }
        });

        return jsonResponse({
          id: "key-1",
          key: "tskey-auth-secret",
          expires: "2026-09-03T01:00:00.000Z",
          capabilities: { devices: { create: { reusable: false, ephemeral: true, tags: ["tag:modeldock-client"] } } }
        });
      }
    });

    await expect(gateway.createAuthKey({})).resolves.toEqual({
      id: "key-1",
      key: "tskey-auth-secret",
      reusable: false,
      ephemeral: true,
      tags: ["tag:modeldock-client"],
      expiresAt: "2026-09-03T01:00:00.000Z"
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json"
    },
    status: 200
  });
}
