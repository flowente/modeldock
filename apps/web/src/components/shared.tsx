import type { ReactNode } from "react";
import type { ComponentHealth, DiagnosticCheckResult } from "../api.js";
import { formatHealthStatus } from "../lib/format.js";

export function PanelHeader({ action, title, subtitle }: { action?: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      {action ?? (subtitle ? <p>{subtitle}</p> : null)}
    </div>
  );
}

export function StatusTile({ icon, label, status, message }: { icon: ReactNode; label: string; status?: ComponentHealth["status"]; message?: string }) {
  const isOn = status === "available";

  return (
    <article className="status-tile">
      <div className="status-tile-head">
        <div className="status-icon">{icon}</div>
        <StatusDot on={isOn} label={`${label} is ${isOn ? "on" : "off"}`} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{formatHealthStatus(status)}</strong>
        <p>{message ?? "Loading status"}</p>
      </div>
    </article>
  );
}

export function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function SwitchToggle({
  disabled,
  label,
  on,
  onClick
}: {
  disabled?: boolean;
  label: string;
  on: boolean;
  onClick(): void;
}) {
  return (
    <button className={`switch-toggle ${on ? "on" : "off"}`} type="button" aria-label={label} aria-pressed={on} disabled={disabled} onClick={onClick}>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </button>
  );
}

export function AccessCheckbox({
  checked,
  description,
  disabled,
  label,
  onClick
}: {
  checked: boolean;
  description?: string;
  disabled?: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <label className={`access-checkbox ${checked ? "checked" : ""}`} title={description}>
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onClick} />
      <span aria-hidden="true" className="checkbox-box">
        {checked ? "✓" : ""}
      </span>
    </label>
  );
}

export function StatusDot({ label, on }: { label: string; on: boolean }) {
  return <span aria-label={label || undefined} className={`status-dot ${on ? "on" : "off"}`} />;
}

export function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) {
    return <p className="ok-copy">All foundation checks are green.</p>;
  }

  return (
    <ul className="warning-list">
      {warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  );
}

export function DiagnosticResultRow({ result }: { result: DiagnosticCheckResult }) {
  const hasProblem = result.status !== "pass";

  return (
    <article className="diagnostic-row">
      <StatusDot on={!hasProblem} label={`${result.label} ${hasProblem ? result.status : "ok"}`} />
      <div className="diagnostic-copy">
        <strong>{result.label}</strong>
        {hasProblem ? <span>{result.message}</span> : null}
      </div>
      <code>{result.durationMs}ms</code>
    </article>
  );
}

export function ErrorState({ message }: { message: string }) {
  return <p className="error-copy">{message}</p>;
}
