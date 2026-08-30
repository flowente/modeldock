import type { TailnetDevice } from "../api.js";

export function UsageAccessRow({
  device,
  enabledModelCount,
  groupName
}: {
  device: TailnetDevice;
  enabledModelCount: number;
  groupName: string;
}) {
  const userName = `${device.hostname.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/(^\.|\.$)/g, "") || "client"}@openwebui`;
  const isReady = device.online === true && device.authorized;

  return (
    <tr>
      <td>
        <strong>{device.hostname}</strong>
        <span className="muted-copy">{device.addresses[0] ?? "No Tailscale IP"}</span>
      </td>
      <td>
        <span className="usage-user-pill">{userName}</span>
      </td>
      <td>{groupName}</td>
      <td>{enabledModelCount} enabled</td>
      <td>
        <span className={`device-status-pill ${isReady ? "online" : "offline"}`}>{isReady ? "Ready" : "Needs check"}</span>
      </td>
    </tr>
  );
}
