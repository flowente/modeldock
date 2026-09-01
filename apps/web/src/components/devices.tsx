import type { ComponentHealth, TailnetDevice } from "../api.js";
import type { LanguagePreference } from "../types.js";
import { formatHealthStatus, formatHealthSummary, formatOnlineStatus, formatReadableDate, getDeviceStatusTone } from "../lib/format.js";
import { getStringArrayHealthDetail, getStringHealthDetail } from "../lib/health.js";
import { DetailItem, StatusDot, SwitchToggle } from "./shared.js";

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
