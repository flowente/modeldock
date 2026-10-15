import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, ApiError, type Account, type ComponentHealth, type DiagnosticCheckResult } from "./chat-api.ts";
import { copyText } from "./markdown.tsx";
import { Card, Feedback, formatDate, formatSize, Heading, Switch } from "./Settings.tsx";

/* ---------------------------------------------------------------- Shared */

type Tone = "ok" | "warn" | "bad" | "off";

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="md-pill" data-tone={tone}>
      {children}
    </span>
  );
}

function toneOf(status: string): Tone {
  if (status === "available" || status === "pass") return "ok";
  if (status === "degraded" || status === "warn" || status === "unknown") return "warn";
  if (status === "not_configured" || status === "skipped") return "off";
  return "bad";
}

const STATUS_LABELS: Record<string, string> = {
  available: "Attivo",
  degraded: "Da controllare",
  unavailable: "Non raggiungibile",
  unknown: "Sconosciuto",
  not_configured: "Spento",
  pass: "OK",
  warn: "Attenzione",
  fail: "Non riuscito",
  skipped: "Saltato"
};

const COMPONENT_LABELS: Record<string, string> = {
  backend: "ModelDock",
  storage: "Archivio (account e conversazioni)",
  ollama: "Ollama (i modelli)",
  link: "Connessione fra dispositivi"
};

const AUDIT_LABELS: Record<string, string> = {
  ACCOUNT_SETUP_COMPLETED: "Primo amministratore creato",
  ACCOUNT_LOGIN: "Accesso",
  ACCOUNT_PASSWORD_CHANGED: "Password cambiata",
  ACCOUNT_RENAMED: "Nome cambiato",
  ACCOUNT_UPDATED: "Account modificato",
  ACCOUNT_DELETED: "Account eliminato",
  INVITATION_CREATED: "Invito creato",
  INVITATION_ACCEPTED: "Invito accettato",
  INVITATION_REVOKED: "Invito revocato",
  GROUP_CREATED: "Gruppo creato",
  GROUP_UPDATED: "Gruppo modificato",
  GROUP_DELETED: "Gruppo eliminato",
  MODEL_ACCESS_POLICY_UPDATED: "Permessi di un modello cambiati",
  MODEL_ACCESS_USER_GRANT_UPDATED: "Modello concesso o tolto a un account",
  MODEL_PULL_SUCCEEDED: "Modello scaricato",
  MODEL_PULL_FAILED: "Download di un modello non riuscito",
  MODEL_DELETE_SUCCEEDED: "Modello eliminato",
  AI_SERVER_STARTED: "Ollama avviato",
  AI_SERVER_MEMORY_RELEASED: "Memoria liberata",
  DIAGNOSTIC_RUN_ALL: "Controlli eseguiti",
  DEVICE_INVITE_CREATED: "Invito per un dispositivo creato",
  DEVICE_INVITE_REVOKED: "Invito per un dispositivo revocato",
  DEVICE_APPROVED: "Dispositivo approvato",
  DEVICE_BLOCKED: "Dispositivo bloccato",
  DEVICE_REMOVED: "Dispositivo rimosso"
};

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-copy-row">
      <code>{value}</code>
      <button
        type="button"
        className="md-outline"
        onClick={async () => {
          if (await copyText(value)) setCopied(true);
        }}
      >
        {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        {copied ? "Copiato" : "Copia"}
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- Server */

export function ServerSection({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const canOperate = account.role === "admin" || account.role === "operator";
  const status = useQuery({ queryKey: ["system-status"], queryFn: api.systemStatus, refetchInterval: 15_000 });
  const resources = useQuery({ queryKey: ["resources"], queryFn: api.resources, refetchInterval: 15_000 });
  const ollama = useQuery({ queryKey: ["ollama-info"], queryFn: api.ollamaInfo });
  const running = useQuery({ queryKey: ["running-models"], queryFn: api.runningModels, refetchInterval: 15_000 });
  const audit = useQuery({ queryKey: ["audit"], queryFn: api.auditEvents });
  const [error, setError] = useState<unknown>(null);

  const refresh = () => Promise.all(["system-status", "resources", "ollama-info", "running-models", "audit", "power"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught);
    } finally {
      await refresh();
    }
  };
  const start = useMutation({ mutationFn: () => run(api.startOllama) });

  const memory = resources.data?.memory;
  const ollamaOn = status.data?.components.ollama.status === "available";
  const components = status.data ? Object.entries(status.data.components) : [];

  return (
    <>
      <Heading title="Server" text="Lo stato di questo computer e dei servizi che fanno funzionare ModelDock. Si aggiorna da solo." />
      <Feedback error={error} />

      <Card title="Ollama" text={ollama.data ? `Modelli in ${ollama.data.modelsPath}` : undefined}>
        <div className="md-status-row">
          <Pill tone={ollamaOn ? "ok" : "bad"}>{ollamaOn ? "Acceso" : "Spento"}</Pill>
          <span className="md-muted">
            {ollamaOn ? `${ollama.data?.modelCount ?? 0} modelli installati.` : "Finché Ollama è spento nessuno può usare la chat."}
          </span>
          {!ollamaOn && canOperate ? (
            <button type="button" className="md-primary" onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? "Avvio…" : "Avvia Ollama"}
            </button>
          ) : null}
        </div>
      </Card>

      <Card title="Memoria del computer" text="I modelli in uso restano caricati in memoria per rispondere subito. Liberarla non cancella niente: il modello si ricarica al messaggio successivo.">
        {memory ? (
          <div className="md-progress-block">
            <div className="md-progress-label">
              <span>
                {formatSize(memory.usedBytes)} usati su {formatSize(memory.totalBytes)}
              </span>
              <span>{Math.round(memory.usedRatio * 100)}%</span>
            </div>
            <div className="md-progress" aria-hidden="true">
              <span style={{ width: `${Math.round(memory.usedRatio * 100)}%` }} />
            </div>
            {resources.data?.cpu.model ? (
              <p className="md-muted">
                {resources.data.cpu.model} · {resources.data.cpu.cores} core
              </p>
            ) : null}
          </div>
        ) : null}
        <ul className="md-plain-list">
          {(running.data ?? []).length === 0 ? <li className="md-muted">Nessun modello caricato in memoria.</li> : null}
          {(running.data ?? []).map((model) => (
            <li key={model.name}>
              <div className="md-person">
                <span>{model.name}</span>
                <small>{model.sizeBytes ? formatSize(model.sizeBytes) : ""}</small>
              </div>
              {canOperate ? (
                <button type="button" className="md-outline" onClick={() => void run(() => api.unloadModel(model.name))}>
                  Togli dalla memoria
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {canOperate && (running.data ?? []).length > 1 ? (
          <div>
            <button type="button" className="md-outline" onClick={() => void run(api.releaseMemory)}>
              Libera tutta la memoria
            </button>
          </div>
        ) : null}
      </Card>

      <Card title="Componenti">
        <ul className="md-plain-list">
          {components.map(([key, component]) => (
            <ComponentRow key={key} label={COMPONENT_LABELS[key] ?? key} component={component} />
          ))}
        </ul>
      </Card>

      <Diagnostics canRun={canOperate} />

      <Card title="Attività recente" text="Chi ha fatto cosa su questo server. Il registro resta sul computer.">
        <ul className="md-plain-list">
          {(audit.data ?? []).slice(0, 15).map((event) => (
            <li key={event.id}>
              <div className="md-person">
                <span>{AUDIT_LABELS[event.action] ?? event.action}</span>
                <small>
                  {formatDate(event.timestamp)}
                  {event.result === "failure" ? " · non riuscito" : ""}
                </small>
              </div>
            </li>
          ))}
          {audit.data && audit.data.length === 0 ? <li className="md-muted">Ancora niente.</li> : null}
        </ul>
      </Card>
    </>
  );
}

function ComponentRow({ label, component }: { label: string; component: ComponentHealth }) {
  return (
    <li>
      <div className="md-person">
        <span>{label}</span>
        <small>{component.message}</small>
      </div>
      <Pill tone={toneOf(component.status)}>{STATUS_LABELS[component.status] ?? component.status}</Pill>
    </li>
  );
}

function Diagnostics({ canRun }: { canRun: boolean }) {
  const [results, setResults] = useState<DiagnosticCheckResult[] | null>(null);
  const runAll = useMutation({ mutationFn: api.runDiagnostics, onSuccess: setResults });
  return (
    <Card title="Controlli" text="Verifiche automatiche su ModelDock, archivio, Ollama e connessione. Gli esiti sono reali, non segnaposto.">
      {canRun ? (
        <div>
          <button type="button" className="md-outline" onClick={() => runAll.mutate()} disabled={runAll.isPending}>
            {runAll.isPending ? "Controllo in corso…" : "Esegui i controlli"}
          </button>
        </div>
      ) : (
        <p className="md-muted">Solo amministratori e operatori possono eseguirli.</p>
      )}
      <Feedback error={runAll.error} />
      {results ? (
        <ul className="md-plain-list">
          {results.map((result) => (
            <li key={result.id}>
              <div className="md-person">
                <span>{result.label}</span>
                <small>
                  {result.message} · {result.durationMs} ms
                </small>
              </div>
              <Pill tone={toneOf(result.status)}>{STATUS_LABELS[result.status] ?? result.status}</Pill>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/* ---------------------------------------------------------------- Devices */

export function DevicesSection() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: 10_000, retry: false });
  const [error, setError] = useState<unknown>(null);
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught);
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
    }
  };

  if (overview.isError && overview.error instanceof ApiError && overview.error.code === "LINK_DISABLED") {
    return (
      <>
        <Heading title="Dispositivi" />
        <Card>
          <p>La connessione fra dispositivi è spenta su questo server. Si riaccende togliendo <code>MODELDOCK_LINK=false</code> dalla configurazione e riavviando ModelDock.</p>
        </Card>
      </>
    );
  }

  const data = overview.data;
  const addresses = data?.connection.hosts.map((host) => `https://${host.host}:${host.port}`) ?? [];

  return (
    <>
      <Heading
        title="Dispositivi"
        text="Gli altri computer e telefoni si collegano direttamente a questo computer, senza servizi esterni. Funziona sulla stessa rete; da fuori casa arriverà più avanti."
      />
      <Feedback error={error ?? overview.error} />

      <Card title="Dal browser, sulla stessa rete">
        {data && !data.connection.allowUnpairedBrowsers ? (
          <p className="md-muted">L'accesso dal browser è spento: si entra solo con ModelDock Link.</p>
        ) : addresses.length === 0 ? (
          <p className="md-muted">Questo computer non è collegato a nessuna rete: nessun dispositivo può raggiungerlo.</p>
        ) : (
          <>
            <p>
              Da un telefono o un computer collegato alla stessa Wi-Fi, apri questo indirizzo ed entra con il tuo account ModelDock:
            </p>
            {addresses.map((address) => (
              <CopyField key={address} value={address} />
            ))}
            <p className="md-muted">
              La prima volta il browser avvisa che il certificato non è riconosciuto. È normale: il certificato l'ha creato questo computer, non
              un'autorità esterna. Per verificarlo, nei dettagli del certificato l'impronta SHA-256 deve essere questa:
            </p>
            {data ? <code className="md-fingerprint">{groupFingerprint(data.connection.fingerprint)}</code> : null}
          </>
        )}
      </Card>

      <DeviceInvite onCreated={() => queryClient.invalidateQueries({ queryKey: ["devices"] })} />

      <Card title="Dispositivi collegati" text="Un dispositivo entra in attesa: lo approvi tu. Bloccarlo lo scollega subito.">
        <ul className="md-plain-list">
          {data && data.devices.length === 0 ? <li className="md-muted">Nessun dispositivo collegato con ModelDock Link.</li> : null}
          {(data?.devices ?? []).map((device) => (
            <li key={device.id}>
              <span className="md-dot-status" data-online={device.online} aria-hidden="true" />
              <div className="md-person">
                <span>
                  {device.hostname}
                  {device.os ? ` · ${device.os}` : ""}
                </span>
                <small>
                  {device.authorized ? (device.online ? "Collegato ora" : device.lastSeen ? `Visto ${formatDate(device.lastSeen)}` : "Mai visto") : "In attesa di approvazione"}
                </small>
              </div>
              <Switch
                checked={device.authorized}
                label={device.authorized ? `Blocca ${device.hostname}` : `Approva ${device.hostname}`}
                onChange={(authorized) => void run(() => api.setDeviceAuthorized(device.id, authorized))}
              />
              <button
                type="button"
                className="md-ghost md-icon-button"
                aria-label={`Rimuovi ${device.hostname}`}
                onClick={() => {
                  if (window.confirm(`Rimuovere ${device.hostname}? Per tornare dovrà ricevere un nuovo invito.`)) void run(() => api.removeDevice(device.id));
                }}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {data && data.invites.length > 0 ? (
        <Card title="Inviti ancora validi">
          <ul className="md-plain-list">
            {data.invites.map((invite) => (
              <li key={invite.id}>
                <div className="md-person">
                  <span>{invite.reusable ? "Invito riutilizzabile" : "Invito valido una volta"}</span>
                  <small>
                    Scade {formatDate(invite.expiresAt)}
                    {invite.requiresPin ? " · con codice" : ""}
                  </small>
                </div>
                <button type="button" className="md-outline" onClick={() => void run(() => api.revokeDeviceInvite(invite.id))}>
                  Revoca
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

function DeviceInvite({ onCreated }: { onCreated: () => Promise<unknown> }) {
  const [requirePin, setRequirePin] = useState(true);
  const [hours, setHours] = useState(24);
  const invite = useMutation({
    mutationFn: () => api.inviteDevice({ requirePin, hours }),
    onSuccess: () => onCreated()
  });
  const result = invite.data;

  return (
    <Card
      title="Collega un computer con ModelDock Link"
      text="Il modo più sicuro: il computer riconosce questo server dal certificato e ogni dispositivo va approvato. Serve il programma ModelDock Link sul computer da collegare."
    >
      <div className="md-inline-form">
        <label className="md-check" style={{ flex: "1 1 260px" }}>
          <input type="checkbox" checked={requirePin} onChange={(event) => setRequirePin(event.target.checked)} />
          <span>
            Chiedi anche un codice di 6 cifre
            <small>Da dire a voce: il link da solo non basta.</small>
          </span>
        </label>
        <label className="md-field" style={{ flex: "0 1 200px" }}>
          Valido per
          <select className="md-select" value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            <option value={1}>1 ora</option>
            <option value={24}>24 ore</option>
            <option value={168}>7 giorni</option>
          </select>
        </label>
        <button type="button" className="md-primary" onClick={() => invite.mutate()} disabled={invite.isPending}>
          Crea l'invito
        </button>
      </div>
      <Feedback error={invite.error} />
      {result ? (
        <div className="md-invite-result">
          <p>
            Link di invito, valido <strong>una volta</strong>
            {result.pin ? (
              <>
                {" "}
                con il codice <strong className="md-pin">{result.pin}</strong>
              </>
            ) : null}
            :
          </p>
          <CopyField value={result.link} />
          <p className="md-muted">
            Sul computer da collegare, ModelDock Link per ora si usa dalla riga di comando (arriverà un programma vero con l'installer):
          </p>
          <CopyField value={`modeldock-link join "${result.link}"${result.pin ? ` --pin ${result.pin}` : ""}`} />
          <p className="md-muted">Poi approvalo qui sotto, e su quel computer avvia <code>modeldock-link proxy</code> e apri http://127.0.0.1:4320.</p>
        </div>
      ) : null}
    </Card>
  );
}

function groupFingerprint(value: string): string {
  return (value.toUpperCase().match(/.{2}/g) ?? []).join(":");
}
