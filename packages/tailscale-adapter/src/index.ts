import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Clock, ComponentHealth, TailnetDevice, TailscaleGateway, UpdateTailnetDeviceInput } from "@modeldock/core";
import { createComponentHealth, ModelDockError } from "@modeldock/core";

const execFileAsync = promisify(execFile);
const DEFAULT_TAILSCALE_API_BASE_URL = "https://api.tailscale.com/api/v2";

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
      return createComponentHealth(
        {
          name: "tailscale",
          status: "unavailable",
          message: "Tailscale CLI is not reachable",
          details: { error: error instanceof Error ? error.message : String(error) }
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

  public async updateDeviceAuthorization(_input: UpdateTailnetDeviceInput): Promise<TailnetDevice> {
    throw new ModelDockError({
      code: "TAILSCALE_WRITE_NOT_CONFIGURED",
      module: "tailscale-adapter",
      message: "Device authorization writes require the Tailscale API adapter.",
      suggestion: "Configure a Tailscale API key before enabling remote device authorization changes."
    });
  }

  private async readStatus(): Promise<TailscaleStatusJson> {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: 5_000,
      windowsHide: true
    });

    return JSON.parse(stdout) as TailscaleStatusJson;
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
