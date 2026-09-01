import type { ReactNode } from "react";
import type { ComponentHealth, DiagnosticCheckResult } from "../api.js";
import type { LanguagePreference } from "../types.js";
import { formatHealthStatus } from "../lib/format.js";

export function PanelHeader({ action, title, subtitle }: { action?: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      {action ?? (subtitle ? <p>{subtitle}</p> : null)}
    </div>
  );
}

export function StatusTile({ icon, label, status, message, language = "en" }: { icon?: ReactNode; label: string; status?: ComponentHealth["status"]; message?: string; language?: LanguagePreference }) {
  const isOn = status === "available";

  return (
    <article className="status-tile">
      <div className="status-tile-head">
        <div className="status-icon">{icon ?? <span>{label.slice(0, 2)}</span>}</div>
        <StatusDot on={isOn} label={language === "it" ? `${label} è ${isOn ? "attivo" : "non attivo"}` : `${label} is ${isOn ? "on" : "off"}`} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{formatHealthStatus(status, language)}</strong>
        <p>{message ?? (language === "it" ? "Caricamento dello stato" : "Loading status")}</p>
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

export function Warnings({ warnings, language = "en" }: { warnings: string[]; language?: LanguagePreference }) {
  if (warnings.length === 0) {
    return <p className="ok-copy">{language === "it" ? "Tutti i controlli principali sono superati." : "All foundation checks are green."}</p>;
  }

  return (
    <ul className="warning-list">
      {warnings.map((warning) => (
        <li key={warning}>{language === "it" ? translateWarning(warning) : warning}</li>
      ))}
    </ul>
  );
}

function translateWarning(warning: string): string {
  return warning
    .replace("Ollama is not reachable", "Ollama non è raggiungibile")
    .replace("Ollama is reachable", "Ollama è raggiungibile")
    .replace("Tailscale is installed but not logged in", "Tailscale è installato ma non è stato effettuato l'accesso")
    .replace("Tailscale CLI is not reachable", "L'applicazione Tailscale non è raggiungibile")
    .replace("Tailscale API token is not configured", "Il token API di Tailscale non è configurato")
    .replace("Open WebUI is not reachable", "Open WebUI non è raggiungibile")
    .replace("Open WebUI URL is not configured yet", "L'URL di Open WebUI non è ancora configurato")
    .replace("not configured", "non configurato")
    .replace("unavailable", "non disponibile");
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
