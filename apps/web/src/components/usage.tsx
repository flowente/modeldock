import type { TailnetDevice } from "../api.js";
import type { LanguagePreference } from "../types.js";

export function UsageAccessRow({
  device,
  enabledModelCount,
  groupName,
  language
}: {
  device: TailnetDevice;
  enabledModelCount: number;
  groupName: string;
  language: LanguagePreference;
}) {
  const userName = `${device.hostname.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/(^\.|\.$)/g, "") || "client"}@openwebui`;
  const isReady = device.online === true && device.authorized;

  return (
    <tr>
      <td>
        <strong>{device.hostname}</strong>
        <span className="muted-copy">{device.addresses[0] ?? (language === "it" ? "Nessun IP Tailscale" : "No Tailscale IP")}</span>
      </td>
      <td>
        <span className="usage-user-pill">{userName}</span>
      </td>
      <td>{groupName}</td>
      <td>{language === "it" ? `${enabledModelCount} abilitati` : `${enabledModelCount} enabled`}</td>
      <td>
        <span className={`device-status-pill ${isReady ? "online" : "offline"}`}>{isReady ? language === "it" ? "Pronto" : "Ready" : language === "it" ? "Da verificare" : "Needs check"}</span>
      </td>
    </tr>
  );
}
