import { Laptop, Monitor, Server, Smartphone, Tablet } from "lucide-react";
import type { ComponentHealth, TailnetDevice } from "../api.js";
import type { LanguagePreference } from "../types.js";
import { formatHealthStatus, formatHealthSummary, formatOnlineStatus, formatReadableDate, getDeviceStatusTone } from "../lib/format.js";
import { getStringArrayHealthDetail, getStringHealthDetail } from "../lib/health.js";
import { DetailItem, StatusDot, SwitchToggle } from "./shared.js";

export function DeviceTopology({
  devices,
  health,
  language,
  serverDeviceId,
  selectedDeviceId,
  onSelect
}: {
  devices: TailnetDevice[];
  health?: ComponentHealth;
  language: LanguagePreference;
  serverDeviceId?: string;
  selectedDeviceId?: string;
  onSelect(deviceId: string): void;
}) {
  const localHostname = getStringHealthDetail(health, "hostname")?.toLowerCase();
  const serverDevice = devices.find((device) => device.id === serverDeviceId)
    ?? devices.find((device) => device.hostname.toLowerCase() === localHostname);
  const clientDevices = devices.filter((device) => device.id !== serverDevice?.id);
  const positions = clientDevices.map((_, index) => getTopologyPosition(index, clientDevices.length));

  return (
    <article className="device-topology">
      <div className="device-topology-heading">
        <div>
          <span className="flow-step">{language === "it" ? "Mappa" : "Map"}</span>
          <h3>{language === "it" ? "La tua rete privata" : "Your private network"}</h3>
        </div>
        <span className="topology-count">{clientDevices.length} {language === "it" ? "client" : "clients"}</span>
      </div>
      <div className="device-topology-canvas" aria-label={language === "it" ? "Mappa dei dispositivi collegati" : "Connected device map"}>
        <svg aria-hidden="true" className="topology-links" viewBox="0 0 100 100" preserveAspectRatio="none">
          {positions.map((position, index) => (
            <line key={clientDevices[index]?.id} x1="50" y1="50" x2={position.x} y2={position.y} />
          ))}
        </svg>
        <div className="topology-node topology-server-node" style={{ left: "50%", top: "50%" }}>
          <span className="topology-node-icon"><Server aria-hidden="true" /></span>
          <strong>{serverDevice?.hostname ?? (language === "it" ? "Questo server" : "This server")}</strong>
          <small>{language === "it" ? "ModelDock" : "ModelDock"}</small>
        </div>
        {clientDevices.map((device, index) => {
          const position = positions[index]!;
          const DeviceIcon = getDeviceIcon(device.os);

          return (
            <button
              aria-pressed={selectedDeviceId === device.id}
              className={`topology-node topology-client-node ${selectedDeviceId === device.id ? "selected" : ""}`}
              key={device.id}
              onClick={() => onSelect(device.id)}
              style={{ left: `${position.x}%`, top: `${position.y}%` }}
              type="button"
            >
              <span className="topology-node-icon"><DeviceIcon aria-hidden="true" /></span>
              <strong>{device.hostname}</strong>
              <small className={device.online === true ? "online" : "offline"}>
                {formatOnlineStatus(device.online, language)}
              </small>
            </button>
          );
        })}
        {clientDevices.length === 0 ? (
          <p className="topology-empty">{language === "it" ? "Invita il primo dispositivo per visualizzarlo qui." : "Invite your first device to see it here."}</p>
        ) : null}
      </div>
    </article>
  );
}

function getTopologyPosition(index: number, total: number): { x: number; y: number } {
  const count = Math.max(total, 1);
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;

  return {
    x: 50 + Math.cos(angle) * 34,
    y: 50 + Math.sin(angle) * 34
  };
}

function getDeviceIcon(os?: string) {
  const normalizedOs = os?.toLowerCase() ?? "";

  if (normalizedOs.includes("ios") || normalizedOs.includes("android")) {
    return Smartphone;
  }

  if (normalizedOs.includes("ipad") || normalizedOs.includes("tablet")) {
    return Tablet;
  }

  if (normalizedOs.includes("mac") || normalizedOs.includes("windows") || normalizedOs.includes("linux")) {
    return Laptop;
  }

  return Monitor;
}

export function TailscaleSummary({ devices, health, language }: { devices: TailnetDevice[]; health?: ComponentHealth; language: LanguagePreference }) {
  const addresses = getStringArrayHealthDetail(health, "addresses");
  const tailnet = getStringHealthDetail(health, "tailnet");
  const hostname = getStringHealthDetail(health, "hostname");
  const onlineDevices = devices.filter((device) => device.online === true).length;

  return (
    <article className="integration-summary">
      <div className="integration-summary-head">
        <StatusDot on={health?.status === "available"} label={language === "it" ? `Stato Tailscale: ${formatHealthStatus(health?.status, language)}` : `Tailscale is ${health?.status ?? "loading"}`} />
        <div>
          <strong>{formatHealthStatus(health?.status, language)}</strong>
          <p>{formatHealthSummary("Tailscale", health?.status, language)}</p>
        </div>
      </div>
      <div className="detail-grid">
        <DetailItem label="Tailnet" value={tailnet ?? (language === "it" ? "Non disponibile" : "Not available")} />
        <DetailItem label={language === "it" ? "Computer" : "Host"} value={hostname ?? (language === "it" ? "Non disponibile" : "Not available")} />
        <DetailItem label="IP Tailscale" value={addresses.join(", ") || (language === "it" ? "Non disponibile" : "Not available")} />
        <DetailItem label={language === "it" ? "Dispositivi connessi" : "Devices online"} value={`${onlineDevices}/${devices.length}`} />
      </div>
    </article>
  );
}

export function NetworkDeviceCard({
  canManage,
  device,
  isUpdating,
  language,
  onUpdate
}: {
  canManage: boolean;
  device: TailnetDevice;
  isUpdating: boolean;
  language: LanguagePreference;
  onUpdate(input: { deviceId: string; hostname: string; authorized: boolean }): void;
}) {
  const onlineStatus = formatOnlineStatus(device.online, language);
  const primaryAddress = device.addresses[0] ?? (language === "it" ? "Nessun indirizzo" : "No address");
  const secondaryAddresses = device.addresses.slice(1).join(", ");

  return (
    <article className="device">
      <div className="device-main">
        <div className="device-title-row">
          <StatusDot on={device.online === true} label={language === "it" ? `${device.hostname}: ${onlineStatus.toLowerCase()}` : `${device.hostname} is ${onlineStatus.toLowerCase()}`} />
          <strong>{device.hostname}</strong>
        </div>
        <div className="device-facts">
          <DetailItem label="IP Tailscale" value={primaryAddress} />
          <DetailItem label={language === "it" ? "Sistema" : "System"} value={device.os ?? (language === "it" ? "Sconosciuto" : "Unknown")} />
          <DetailItem label={language === "it" ? "Ultimo accesso" : "Last seen"} value={device.lastSeen ? formatReadableDate(device.lastSeen, language) : language === "it" ? "Non disponibile" : "Not available"} />
        </div>
        {secondaryAddresses ? <span className="device-secondary-addresses">{secondaryAddresses}</span> : null}
      </div>
      <div className="device-controls">
        <div className="device-control-group">
          <span className="device-control-label">{language === "it" ? "Connessione" : "Connection"}</span>
          <span className={`device-status-pill ${getDeviceStatusTone(device.online)}`}>{onlineStatus}</span>
        </div>
        <div className="device-control-group">
          <span className="device-control-label">{language === "it" ? "Attivo" : "Active"}</span>
          <SwitchToggle
            disabled={!canManage || isUpdating}
            label={language === "it" ? `Autorizzazione di ${device.hostname}: ${device.authorized ? "attiva" : "non attiva"}` : `${device.hostname} authorization is ${device.authorized ? "active" : "inactive"}`}
            on={device.authorized}
            onClick={() => onUpdate({ deviceId: device.id, hostname: device.hostname, authorized: !device.authorized })}
          />
        </div>
      </div>
    </article>
  );
}
