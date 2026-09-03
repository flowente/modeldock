import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Clock,
  ComponentHealth,
  CreateTailnetAuthKeyInput,
  CreateTailnetUserInviteInput,
  TailnetAuthKey,
  TailnetDevice,
  TailnetUserInvite,
  TailscaleGateway,
  UpdateTailnetDeviceInput
} from "@modeldock/core";
import { createComponentHealth, ModelDockError } from "@modeldock/core";

const execFileAsync = promisify(execFile);
const DEFAULT_TAILSCALE_API_BASE_URL = "https://api.tailscale.com/api/v2";
const TAILSCALE_STATUS_ARGS = ["status", "--json"];
const WINDOWS_TAILSCALE_EXE = "C:\\Program Files\\Tailscale\\tailscale.exe";

interface TailscaleStatusJson {
  BackendState?: string;
  CurrentTailnet?: {
    Name?: string;
    MagicDNSSuffix?: string;
  };
  Self?: {
    ID?: string;
    HostName?: string;
    DNSName?: string;
    TailscaleIPs?: string[];
    Online?: boolean;
    OS?: string;
  };
  Peer?: Record<
    string,
    {
      ID?: string;
      HostName?: string;
      DNSName?: string;
      TailscaleIPs?: string[];
      Online?: boolean;
      OS?: string;
      LastSeen?: string;
    }
  >;
}

interface TailscaleApiGatewayOptions {
  apiToken?: string;
  baseUrl?: string;
  clock: Clock;
  fetchImpl?: typeof fetch;
  tailnet?: string;
}

interface TailscaleApiDevice {
  id?: string;
  nodeId?: string;
  name?: string;
  hostname?: string;
  dnsName?: string;
  addresses?: string[];
  tailscaleIPs?: string[];
  online?: boolean;
  connectedToControl?: boolean;
  authorized?: boolean;
  os?: string;
  lastSeen?: string;
  user?: string;
  tags?: string[];
}

interface TailscaleApiDevicesResponse {
  devices?: TailscaleApiDevice[];
}

interface TailscaleApiUserInvite {
  id?: string;
  inviteUrl?: string;
  role?: string;
  email?: string;
  expiresAt?: string;
}

interface TailscaleApiAuthKey {
  id?: string;
  key?: string;
  expires?: string;
  capabilities?: {
    devices?: {
      create?: {
        reusable?: boolean;
        ephemeral?: boolean;
        tags?: string[];
      };
    };
  };
}

export const DEFAULT_MODELDOCK_CLIENT_TAG = "tag:modeldock-client";
const DEFAULT_AUTH_KEY_EXPIRY_SECONDS = 3_600;

export class TailscaleCliGateway implements TailscaleGateway {
  private readonly clock: Clock;

  public constructor(clock: Clock) {
    this.clock = clock;
  }

  public async getLocalStatus(): Promise<ComponentHealth> {
    try {
      const status = await this.readStatus();
      const self = status.Self;
      const backendState = status.BackendState;

      if (!self) {
        return createComponentHealth(
          {
            name: "tailscale",
            status: backendState === "NeedsLogin" ? "not_configured" : "unknown",
            message: backendState === "NeedsLogin" ? "Tailscale is installed but not logged in" : "Tailscale status did not include local node data",
            details: {
              backendState,
              tailnet: status.CurrentTailnet?.Name
            }
          },
          this.clock
        );
      }

      return createComponentHealth(
        {
          name: "tailscale",
          status: self.Online === false ? "degraded" : "available",
          message: self.Online === false ? "Tailscale is present but local node is offline" : "Tailscale is connected",
          details: {
            backendState,
            tailnet: status.CurrentTailnet?.Name,
            magicDnsSuffix: status.CurrentTailnet?.MagicDNSSuffix,
            hostname: self.HostName ?? self.DNSName,
            addresses: self.TailscaleIPs ?? [],
            os: self.OS
          }
        },
        this.clock
      );
    } catch (error) {
      const cliError = getTailscaleCliErrorDetails(error);
      const accessDenied = cliError.error.includes("Access is denied");

      return createComponentHealth(
        {
          name: "tailscale",
          status: accessDenied ? "degraded" : "unavailable",
          message: accessDenied ? "Tailscale is installed, but local status access is denied" : "Tailscale CLI is not reachable",
          details: cliError
        },
        this.clock
      );
    }
  }

  public async listDevices(): Promise<TailnetDevice[]> {
    const status = await this.readStatus();
    const self = status.Self ? [this.mapDevice("self", status.Self)] : [];
    const peers = Object.entries(status.Peer ?? {}).map(([fallbackId, peer]) => this.mapDevice(fallbackId, peer));

    return [...self, ...peers];
  }

  public async createUserInvite(_input: CreateTailnetUserInviteInput): Promise<TailnetUserInvite> {
    throw new ModelDockError({
      code: "TAILSCALE_WRITE_NOT_CONFIGURED",
      module: "tailscale-adapter",
      message: "Creating a real Tailscale invite requires the Tailscale API adapter.",
      suggestion: "Configure a Tailscale API key before inviting a device from ModelDock."
    });
  }

  public async createAuthKey(_input: CreateTailnetAuthKeyInput): Promise<TailnetAuthKey> {
    throw new ModelDockError({
      code: "TAILSCALE_WRITE_NOT_CONFIGURED",
      module: "tailscale-adapter",
      message: "Generating a device auth key requires the Tailscale API adapter.",
      suggestion: "Configure a Tailscale API key with the auth_keys scope before inviting devices."
    });
  }

  public async updateDeviceAuthorization(_input: UpdateTailnetDeviceInput): Promise<TailnetDevice> {
    throw new ModelDockError({
      code: "TAILSCALE_WRITE_NOT_CONFIGURED",
      module: "tailscale-adapter",
      message: "Device authorization writes require the Tailscale API adapter.",
      suggestion: "Configure a Tailscale API key before enabling remote device authorization changes."
    });
  }

  private async readStatus(): Promise<TailscaleStatusJson> {
    let lastError: unknown;

    for (const command of getTailscaleCommandCandidates()) {
      try {
        return await readStatusFromCommand(command);
      } catch (error) {
        lastError = error;

        if (getTailscaleCliErrorDetails(error).accessDenied) {
          break;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private mapDevice(
    fallbackId: string,
    device: {
      ID?: string;
      HostName?: string;
      DNSName?: string;
      TailscaleIPs?: string[];
      Online?: boolean;
      OS?: string;
      LastSeen?: string;
    }
  ): TailnetDevice {
    return {
      id: device.ID ?? fallbackId,
      hostname: device.HostName ?? device.DNSName ?? "unknown",
      addresses: device.TailscaleIPs ?? [],
      online: typeof device.Online === "boolean" ? device.Online : "unknown",
      authorized: true,
      os: device.OS,
      lastSeen: device.LastSeen
    };
  }
}

async function readStatusFromCommand(command: string): Promise<TailscaleStatusJson> {
  try {
    const { stdout } = await execFileAsync(command, TAILSCALE_STATUS_ARGS, {
      timeout: 8_000,
      windowsHide: true
    });

    return JSON.parse(stdout) as TailscaleStatusJson;
  } catch (error) {
    const stdout = getExecStdout(error);

    if (stdout) {
      return JSON.parse(stdout) as TailscaleStatusJson;
    }

    throw error;
  }
}

function getTailscaleCommandCandidates(): string[] {
  if (process.platform !== "win32") {
    return ["tailscale"];
  }

  return ["tailscale.exe", WINDOWS_TAILSCALE_EXE];
}

function getExecStdout(error: unknown): string | undefined {
  const stdout = (error as { stdout?: unknown }).stdout;

  return typeof stdout === "string" && stdout.trim() ? stdout : undefined;
}

function getTailscaleCliErrorDetails(error: unknown): { accessDenied: boolean; error: string } {
  const stdout = (error as { stdout?: unknown }).stdout;
  const stderr = (error as { stderr?: unknown }).stderr;
  const message = error instanceof Error ? error.message : String(error);
  const output =
    typeof stderr === "string" && stderr.trim()
      ? stderr.trim()
      : typeof stdout === "string" && stdout.trim()
        ? stdout.trim()
        : message;

  return {
    accessDenied: output.includes("Access is denied"),
    error: output
  };
}

export class TailscaleApiGateway implements TailscaleGateway {
  private readonly apiToken?: string;
  private readonly baseUrl: string;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly tailnet: string;

  public constructor(options: TailscaleApiGatewayOptions) {
    this.apiToken = options.apiToken?.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_TAILSCALE_API_BASE_URL).replace(/\/$/, "");
    this.clock = options.clock;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tailnet = options.tailnet?.trim() || "-";
  }

  public async getLocalStatus(): Promise<ComponentHealth> {
    if (!this.apiToken) {
      return createComponentHealth(
        {
          name: "tailscale",
          status: "not_configured",
          message: "Tailscale API token is not configured",
          details: {
            mode: "api",
            tailnet: this.tailnet
          }
        },
        this.clock
      );
    }

    try {
      const devices = await this.listDevices();
      const onlineDevices = devices.filter((device) => device.online === true).length;

      return createComponentHealth(
        {
          name: "tailscale",
          status: "available",
          message: `Tailscale API is reachable (${devices.length} devices)`,
          details: {
            mode: "api",
            tailnet: this.tailnet,
            devices: devices.length,
            onlineDevices
          }
        },
        this.clock
      );
    } catch (error) {
      return createComponentHealth(
        {
          name: "tailscale",
          status: "unavailable",
          message: "Tailscale API is not reachable",
          details: {
            mode: "api",
            tailnet: this.tailnet,
            error: error instanceof Error ? error.message : String(error)
          }
        },
        this.clock
      );
    }
  }

  public async listDevices(): Promise<TailnetDevice[]> {
    const payload = await this.request<TailscaleApiDevicesResponse>(`/tailnet/${encodeURIComponent(this.tailnet)}/devices?fields=all`);

    return (payload.devices ?? []).map((device, index) => this.mapDevice(device, index));
  }

  public async createUserInvite(input: CreateTailnetUserInviteInput): Promise<TailnetUserInvite> {
    const email = input.email?.trim().toLowerCase();
    const payload = await this.request<TailscaleApiUserInvite>(`/tailnet/${encodeURIComponent(this.tailnet)}/user-invites`, {
      body: JSON.stringify({
        role: "member",
        ...(email ? { email } : {})
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });

    if (!payload.id || !payload.inviteUrl) {
      throw new ModelDockError({
        code: "TAILSCALE_INVITE_INVALID_RESPONSE",
        module: "tailscale-adapter",
        message: "Tailscale created an invite but did not return its link"
      });
    }

    return {
      id: payload.id,
      inviteUrl: payload.inviteUrl,
      role: "member",
      email: payload.email ?? email,
      expiresAt: payload.expiresAt
    };
  }

  public async createAuthKey(input: CreateTailnetAuthKeyInput): Promise<TailnetAuthKey> {
    const tags = input.tags && input.tags.length > 0 ? input.tags : [DEFAULT_MODELDOCK_CLIENT_TAG];
    const reusable = input.reusable ?? false;
    const ephemeral = input.ephemeral ?? true;

    const payload = await this.request<TailscaleApiAuthKey>(`/tailnet/${encodeURIComponent(this.tailnet)}/keys`, {
      body: JSON.stringify({
        description: input.description ?? "ModelDock client invite",
        expirySeconds: input.expirySeconds ?? DEFAULT_AUTH_KEY_EXPIRY_SECONDS,
        capabilities: {
          devices: {
            create: {
              reusable,
              ephemeral,
              preauthorized: input.preauthorized ?? true,
              tags
            }
          }
        }
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });

    if (!payload.key) {
      throw new ModelDockError({
        code: "TAILSCALE_AUTH_KEY_INVALID_RESPONSE",
        module: "tailscale-adapter",
        message: "Tailscale created an auth key but did not return its secret value"
      });
    }

    const created = payload.capabilities?.devices?.create;

    return {
      id: payload.id ?? "",
      key: payload.key,
      reusable: created?.reusable ?? reusable,
      ephemeral: created?.ephemeral ?? ephemeral,
      tags: created?.tags ?? tags,
      expiresAt: payload.expires
    };
  }

  public async updateDeviceAuthorization(input: UpdateTailnetDeviceInput): Promise<TailnetDevice> {
    await this.request<unknown>(`/device/${encodeURIComponent(input.deviceId)}/authorized`, {
      body: JSON.stringify({ authorized: input.authorized }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });

    const devices = await this.listDevices();
    const updated = devices.find((device) => device.id === input.deviceId);

    if (!updated) {
      throw new ModelDockError({
        code: "TAILNET_DEVICE_NOT_FOUND",
        module: "tailscale-adapter",
        message: `Tailscale device ${input.deviceId} was updated but could not be read back`
      });
    }

    return updated;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.apiToken) {
      throw new ModelDockError({
        code: "TAILSCALE_API_NOT_CONFIGURED",
        module: "tailscale-adapter",
        message: "Tailscale API token is required",
        suggestion: "Set MODELDOCK_TAILSCALE_API_TOKEN before using the Tailscale API adapter."
      });
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        ...init.headers
      }
    });

    if (!response.ok) {
      throw new ModelDockError({
        code: "TAILSCALE_API_REQUEST_FAILED",
        module: "tailscale-adapter",
        message: `Tailscale API request failed with HTTP ${response.status}`,
        suggestion: response.status === 401 || response.status === 403 ? "Check the Tailscale API token scopes and expiry." : undefined
      });
    }

    const body = await response.text();

    if (!body) {
      return {} as T;
    }

    return JSON.parse(body) as T;
  }

  private mapDevice(device: TailscaleApiDevice, index: number): TailnetDevice {
    const id = device.id ?? device.nodeId ?? `tailscale-device-${index}`;

    return {
      id,
      hostname: device.hostname ?? device.name ?? device.dnsName ?? "unknown",
      addresses: device.addresses ?? device.tailscaleIPs ?? [],
      online: typeof device.connectedToControl === "boolean" ? device.connectedToControl : typeof device.online === "boolean" ? device.online : "unknown",
      authorized: device.authorized ?? false,
      os: device.os,
      lastSeen: device.lastSeen
    };
  }
}
