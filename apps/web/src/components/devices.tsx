import type { ComponentHealth, TailnetDevice } from "../api.js";
import { formatHealthStatus, formatOnlineStatus, formatReadableDate, getDeviceStatusTone } from "../lib/format.js";
import { getStringArrayHealthDetail, getStringHealthDetail } from "../lib/health.js";
import { DetailItem, StatusDot, SwitchToggle } from "./shared.js";

export function TailscaleSummary({ devices, health }: { devices: TailnetDevice[]; health?: ComponentHealth }) {
  const addresses = getStringArrayHealthDetail(health, "addresses");
  const tailnet = getStringHealthDetail(health, "tailnet");
  const hostname = getStringHealthDetail(health, "hostname");
  const onlineDevices = devices.filter((device) => device.online === true).length;

  return (
    <article className="integration-summary">
      <div className="integration-summary-head">
        <StatusDot on={health?.status === "available"} label={`Tailscale is ${health?.status ?? "loading"}`} />
        <div>
          <strong>{formatHealthStatus(health?.status)}</strong>
          <p>{health?.message ?? "Reading Tailscale status"}</p>
        </div>
      </div>
      <div className="detail-grid">
        <DetailItem label="Tailnet" value={tailnet ?? "Not available"} />
        <DetailItem label="Host" value={hostname ?? "Not available"} />
        <DetailItem label="Tailscale IP" value={addresses.join(", ") || "Not available"} />
        <DetailItem label="Devices online" value={`${onlineDevices}/${devices.length}`} />
      </div>
    </article>
  );
}

export function NetworkDeviceCard({
  canManage,
  device,
  isUpdating,
  onUpdate
}: {
  canManage: boolean;
  device: TailnetDevice;
  isUpdating: boolean;
  onUpdate(input: { deviceId: string; hostname: string; authorized: boolean }): void;
}) {
  const onlineStatus = formatOnlineStatus(device.online);
  const primaryAddress = device.addresses[0] ?? "No address";
  const secondaryAddresses = device.addresses.slice(1).join(", ");

  return (
    <article className="device">
      <div className="device-main">
        <div className="device-title-row">
          <StatusDot on={device.online === true} label={`${device.hostname} is ${onlineStatus.toLowerCase()}`} />
          <strong>{device.hostname}</strong>
        </div>
        <div className="device-facts">
          <DetailItem label="Tailscale IP" value={primaryAddress} />
          <DetailItem label="System" value={device.os ?? "Unknown"} />
          <DetailItem label="Last seen" value={device.lastSeen ? formatReadableDate(device.lastSeen) : "Not available"} />
        </div>
        {secondaryAddresses ? <span className="device-secondary-addresses">{secondaryAddresses}</span> : null}
      </div>
      <div className="device-controls">
        <div className="device-control-group">
          <span className="device-control-label">Connection</span>
          <span className={`device-status-pill ${getDeviceStatusTone(device.online)}`}>{onlineStatus}</span>
        </div>
        <div className="device-control-group">
          <span className="device-control-label">Active</span>
          <SwitchToggle
            disabled={!canManage || isUpdating}
            label={`${device.hostname} authorization is ${device.authorized ? "active" : "inactive"}`}
            on={device.authorized}
            onClick={() => onUpdate({ deviceId: device.id, hostname: device.hostname, authorized: !device.authorized })}
          />
        </div>
      </div>
    </article>
  );
}
