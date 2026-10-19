import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, Trash2 } from "lucide-react";
import { ApiKeysSection } from "./settings-api-keys.tsx";
import { CommandsSection } from "./settings-commands.tsx";
import { DevicesSection, ServerSection } from "./settings-server.tsx";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type Account, type DevicesOverview, type ModelPullJob, type Role, type StoredGroup } from "./chat-api.ts";
import { explain, type ThemeChoice, type ThemeControl } from "./ChatApp.tsx";
import { copyText } from "./markdown.tsx";
import "./settings.css";

const ROLE_LABELS: Record<Role, string> = {
  admin: "Amministratore",
  operator: "Operatore",
  viewer: "Visualizzatore",
  member: "Membro"
};

const ROLE_HINTS: Record<Role, string> = {
  member: "Usa la chat con i modelli che gli concedi.",
  viewer: "Chat, più la lettura dello stato del server.",
  operator: "Chat e gestione del server, ma non degli account.",
  admin: "Tutto, compresi account e permessi."
};

interface Section {
  id: string;
  label: string;
  visible: (account: Account) => boolean;
}

const SECTIONS: Section[] = [
  { id: "account", label: "Account", visible: () => true },
  { id: "aspetto", label: "Aspetto", visible: () => true },
  { id: "comandi", label: "Comandi rapidi", visible: () => true },
  { id: "chiavi-api", label: "Chiavi API", visible: () => true },
  { id: "modelli", label: "Modelli e permessi", visible: (account) => account.role === "admin" },
  { id: "utenti", label: "Utenti e gruppi", visible: (account) => account.role === "admin" },
  { id: "dispositivi", label: "Dispositivi", visible: (account) => account.role === "admin" },
  { id: "server", label: "Server", visible: (account) => account.role !== "member" }
];

export function Settings({
  account,
  section,
  detail,
  theme,
  onAccountChanged
}: {
  account: Account;
  section: string;
  /** What comes after the section in the address, such as one API key. */
  detail?: string;
  theme: ThemeControl;
  onAccountChanged: () => Promise<void>;
}) {
  const visible = SECTIONS.filter((candidate) => candidate.visible(account));
  const current = visible.find((candidate) => candidate.id === section) ?? visible[0]!;

  return (
    <div className="md-settings">
      <aside className="md-settings-nav">
        <a className="md-settings-back" href="#/">
          <ArrowLeft size={16} aria-hidden="true" />
          Torna alla chat
        </a>
        <div className="md-eyebrow">Impostazioni</div>
        <nav aria-label="Sezioni delle impostazioni">
          {visible.map((candidate) => (
            <a key={candidate.id} href={`#/impostazioni/${candidate.id}`} aria-current={candidate.id === current.id ? "page" : undefined}>
              {candidate.label}
            </a>
          ))}
        </nav>
      </aside>
      <main className="md-settings-main">
        <div className="md-settings-content">
          {current.id === "account" ? <AccountSection account={account} onChanged={onAccountChanged} /> : null}
          {current.id === "aspetto" ? <AppearanceSection theme={theme} /> : null}
          {current.id === "comandi" ? <CommandsSection account={account} /> : null}
          {current.id === "chiavi-api" ? <ApiKeysSection account={account} {...(detail ? { detail } : {})} /> : null}
          {current.id === "modelli" ? <ModelsSection /> : null}
          {current.id === "utenti" ? <UsersSection account={account} /> : null}
          {current.id === "dispositivi" ? <DevicesSection /> : null}
          {current.id === "server" ? <ServerSection account={account} /> : null}
        </div>
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------- Shared bits */

export function Heading({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="md-settings-heading">
      <div>
        <h1>{title}</h1>
        {text ? <p>{text}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Card({ title, text, children }: { title?: string; text?: string; children: ReactNode }) {
  return (
    <section className="md-card">
      {title ? (
        <div className="md-card-head">
          <h2>{title}</h2>
          {text ? <p>{text}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Feedback({ error, success }: { error?: unknown; success?: string | null }) {
  if (error) {
    return (
      <div className="md-form-error" role="alert">
        {explain(error)}
      </div>
    );
  }
  if (success) {
    return (
      <div className="md-form-success" role="status">
        {success}
      </div>
    );
  }
  return null;
}

export function Switch({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="md-switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function formatSize(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/* ---------------------------------------------------------------- Account */

function AccountSection({ account, onChanged }: { account: Account; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(account.displayName);
  const rename = useMutation({ mutationFn: () => api.renameMe(name), onSuccess: onChanged });

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const password = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
    }
  });

  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    setMismatch(next !== confirm);
    if (next === confirm) password.mutate();
  };

  return (
    <>
      <Heading title="Account" text={`${account.email} · ${ROLE_LABELS[account.role]}`} />
      <Card title="Nome">
        <form
          className="md-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          <label className="md-field" style={{ flex: "1 1 240px" }}>
            Come ti chiamano gli altri
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required />
          </label>
          <button type="submit" className="md-primary" disabled={rename.isPending || name.trim() === account.displayName}>
            Salva
          </button>
        </form>
        <Feedback error={rename.error} success={rename.isSuccess ? "Nome aggiornato." : null} />
      </Card>
      <Card title="Password" text="Cambiandola, ModelDock chiude le tue sessioni sugli altri dispositivi.">
        <form className="md-stack-form" onSubmit={submitPassword}>
          <label className="md-field">
            Password attuale
            <input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" required />
          </label>
          <label className="md-field">
            Nuova password
            <input type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" minLength={8} required />
            <small>Almeno 8 caratteri.</small>
          </label>
          <label className="md-field">
            Ripeti la nuova password
            <input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" required />
          </label>
          {mismatch ? (
            <div className="md-form-error" role="alert">
              Le due password nuove non coincidono.
            </div>
          ) : (
            <Feedback error={password.error} success={password.isSuccess ? "Password cambiata." : null} />
          )}
          <div>
            <button type="submit" className="md-primary" disabled={password.isPending}>
              Cambia password
            </button>
          </div>
        </form>
      </Card>
    </>
  );
}

/* ---------------------------------------------------------------- Appearance */

function AppearanceSection({ theme }: { theme: ThemeControl }) {
  const options: Array<{ id: ThemeChoice; label: string; hint: string }> = [
    { id: "system", label: "Come il sistema", hint: "Segue il chiaro o lo scuro del dispositivo." },
    { id: "light", label: "Chiaro", hint: "" },
    { id: "dark", label: "Scuro", hint: "" }
  ];
  return (
    <>
      <Heading title="Aspetto" text="La scelta vale per questo browser." />
      <Card>
        <fieldset className="md-radio-list">
          <legend className="md-sr-only">Tema</legend>
          {options.map((option) => (
            <label key={option.id} className="md-radio">
              <input type="radio" name="theme" checked={theme.choice === option.id} onChange={() => theme.choose(option.id)} />
              <span>
                {option.label}
                {option.hint ? <small>{option.hint}</small> : null}
              </span>
            </label>
          ))}
        </fieldset>
      </Card>
    </>
  );
}

/* ---------------------------------------------------------------- Models and permissions */

function ModelsSection() {
  const queryClient = useQueryClient();
  const installed = useQuery({ queryKey: ["installed-models"], queryFn: api.installedModels });
  const matrix = useQuery({ queryKey: ["access-matrix"], queryFn: api.accessMatrix });
  const capabilities = useQuery({ queryKey: ["model-capabilities"], queryFn: api.modelCapabilities });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["access-matrix"] });
    await queryClient.invalidateQueries({ queryKey: ["installed-models"] });
    await queryClient.invalidateQueries({ queryKey: ["model-capabilities"] });
    await queryClient.invalidateQueries({ queryKey: ["chat-models"] });
  };
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught);
    }
  };

  const groups = matrix.data?.groups ?? [];
  const users = matrix.data?.users ?? [];
  const policies = new Map((matrix.data?.models ?? []).map((policy) => [policy.modelName, policy]));
  const models = installed.data ?? [];
  const chosen = models.find((model) => model.name === selected) ?? null;
  const chosenPolicy = chosen ? policies.get(chosen.name) : undefined;

  const whoCanUse = (name: string): string => {
    const policy = policies.get(name);
    if (!policy) return "Solo amministratori";
    const groupNames = policy.grants
      .filter((grant) => grant.canUse && grant.subject.type === "group")
      .map((grant) => groups.find((group) => group.id === grant.subject.id)?.name)
      .filter(Boolean);
    const people = policy.grants.filter((grant) => grant.canUse && grant.subject.type === "user").length;
    const parts = [...groupNames, ...(people ? [`${people} account`] : [])];
    return parts.length ? `Amministratori, ${parts.join(", ")}` : "Solo amministratori";
  };

  return (
    <>
      <Heading
        title="Modelli e permessi"
        text="Scegli quali modelli sono attivi e chi può usarli. Un modello non concesso sparisce dall'elenco di chi non ha il permesso, e il server rifiuta le richieste fatte comunque. Gli amministratori li usano sempre tutti."
      />
      <PullModel onDone={refresh} />
      <Feedback error={error} />
      <div className="md-table-card">
        <table className="md-table">
          <thead>
            <tr>
              <th scope="col">Modello</th>
              <th scope="col">Dimensione</th>
              <th scope="col">Chi può usarlo</th>
              <th scope="col" className="md-right">
                Attivo
              </th>
              <th scope="col">
                <span className="md-sr-only">Azioni</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {installed.isPending ? (
              <tr>
                <td colSpan={5} className="md-muted">
                  Caricamento…
                </td>
              </tr>
            ) : null}
            {!installed.isPending && models.length === 0 ? (
              <tr>
                <td colSpan={5} className="md-muted">
                  Nessun modello installato. Scaricane uno qui sopra.
                </td>
              </tr>
            ) : null}
            {models.map((model) => {
              const chat = capabilities.data?.[model.name]?.chat ?? true;
              const policy = policies.get(model.name);
              return (
                <tr key={model.name} data-selected={model.name === selected}>
                  <td>
                    {chat ? (
                      <button type="button" className="md-link-button" onClick={() => setSelected(model.name === selected ? null : model.name)}>
                        {model.name}
                      </button>
                    ) : (
                      <span className="md-muted">{model.name}</span>
                    )}
                  </td>
                  <td className="md-mono">{formatSize(model.sizeBytes)}</td>
                  <td className={chat ? undefined : "md-muted"}>{chat ? whoCanUse(model.name) : "Non è un modello di chat: serve alla ricerca nei documenti."}</td>
                  <td className="md-right">
                    {chat ? (
                      <Switch
                        checked={policy?.enabled ?? true}
                        label={`${model.name} attivo`}
                        onChange={(enabled) => void run(() => api.updatePolicy(model.name, { enabled }))}
                      />
                    ) : null}
                  </td>
                  <td className="md-right">
                    <button
                      type="button"
                      className="md-ghost md-icon-button"
                      aria-label={`Elimina ${model.name}`}
                      onClick={() => {
                        if (window.confirm(`Eliminare ${model.name} da questo computer? Andrà scaricato di nuovo per usarlo.`)) {
                          void run(async () => {
                            await api.deleteModel(model.name);
                            if (selected === model.name) setSelected(null);
                          });
                        }
                      }}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {chosen ? (
        <Card title={`${chosen.name} · chi può usarlo`} text="Concedilo a un gruppo intero, o a singoli account in aggiunta.">
          <fieldset className="md-check-list">
            <legend className="md-eyebrow">Gruppi</legend>
            <label className="md-check">
              <input type="checkbox" checked disabled />
              <span>Amministratori</span>
              <small>Sempre</small>
            </label>
            {groups.length === 0 ? <p className="md-muted">Non ci sono gruppi. Creali in Utenti e gruppi.</p> : null}
            {groups.map((group) => {
              const granted = Boolean(chosenPolicy?.grants.some((grant) => grant.canUse && grant.subject.type === "group" && grant.subject.id === group.id));
              const members = users.filter((user) => user.groupIds.includes(group.id)).length;
              return (
                <label key={group.id} className="md-check">
                  <input
                    type="checkbox"
                    checked={granted}
                    onChange={(event) => void run(() => api.updatePolicy(chosen.name, { groupGrants: { [group.id]: event.target.checked } }))}
                  />
                  <span>{group.name}</span>
                  <small>{members} account</small>
                </label>
              );
            })}
          </fieldset>
          <fieldset className="md-check-list">
            <legend className="md-eyebrow">Singoli account</legend>
            {users.filter((user) => user.role !== "admin").length === 0 ? <p className="md-muted">Non ci sono altri account oltre agli amministratori.</p> : null}
            {users
              .filter((user) => user.role !== "admin")
              .map((user) => {
                const granted = Boolean(chosenPolicy?.grants.some((grant) => grant.canUse && grant.subject.type === "user" && grant.subject.id === user.id));
                return (
                  <label key={user.id} className="md-check">
                    <input type="checkbox" checked={granted} onChange={(event) => void run(() => api.setUserGrant(chosen.name, user.id, event.target.checked))} />
                    <span>{user.displayName}</span>
                    <small>{ROLE_LABELS[user.role]}</small>
                  </label>
                );
              })}
          </fieldset>
        </Card>
      ) : null}
    </>
  );
}

function PullModel({ onDone }: { onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [job, setJob] = useState<ModelPullJob | null>(null);
  const [error, setError] = useState<unknown>(null);
  const active = job && (job.status === "queued" || job.status === "running");

  // Follow the download until it ends.
  useEffect(() => {
    if (!job || !active) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.pullJob(job.id);
        setJob(next);
        if (next.status === "succeeded") await onDone();
      } catch (caught) {
        setError(caught);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [job?.id, active]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      setJob(await api.pullModel(name.trim()));
    } catch (caught) {
      setError(caught);
    }
  };

  const percent = job?.totalBytes ? Math.round(((job.completedBytes ?? 0) / job.totalBytes) * 100) : null;

  return (
    <Card title="Scarica un modello" text="Il nome come compare nel catalogo di Ollama, per esempio gemma3:4b. Un modello nuovo lo usano solo gli amministratori finché non lo concedi.">
      <form className="md-inline-form" onSubmit={start}>
        <label className="md-field" style={{ flex: "1 1 240px" }}>
          <span className="md-sr-only">Nome del modello</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="gemma3:4b" disabled={Boolean(active)} required />
        </label>
        <button type="submit" className="md-primary" disabled={Boolean(active) || !name.trim()}>
          {active ? "Download in corso…" : "Scarica"}
        </button>
      </form>
      <p className="md-muted">
        Il catalogo è su{" "}
        <a href="https://ollama.com/library" target="_blank" rel="noopener noreferrer">
          ollama.com/library
        </a>
        .
      </p>
      {job ? (
        <div className="md-progress-block" role="status">
          <div className="md-progress-label">
            <span>{job.model}</span>
            <span>
              {job.status === "succeeded" ? "Scaricato" : job.status === "failed" ? "Non riuscito" : percent !== null ? `${percent}%` : job.message}
            </span>
          </div>
          {job.status !== "failed" ? (
            <div className="md-progress" aria-hidden="true">
              <span style={{ width: `${job.status === "succeeded" ? 100 : (percent ?? 2)}%` }} />
            </div>
          ) : (
            <div className="md-form-error">{job.error ?? job.message}</div>
          )}
        </div>
      ) : null}
      <Feedback error={error} />
    </Card>
  );
}

/* ---------------------------------------------------------------- Users and groups */

function UsersSection({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: api.users });
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });
  const invitations = useQuery({ queryKey: ["invitations"], queryFn: api.invitations });
  const [error, setError] = useState<unknown>(null);

  const refresh = async () => {
    await Promise.all(["users", "groups", "invitations", "access-matrix"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  };
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught);
    }
  };

  const allGroups = groups.data ?? [];
  const pending = (invitations.data ?? []).filter((invitation) => !invitation.usedAt && Date.parse(invitation.expiresAt) > Date.now());

  return (
    <>
      <Heading title="Utenti e gruppi" text="Chi entra in ModelDock, con quale ruolo e in quali gruppi. I gruppi servono a concedere i modelli a più persone insieme." />
      <InviteForm groups={allGroups} onInvited={refresh} />
      <Feedback error={error} />

      <Card title="Account">
        <div className="md-table-scroll">
          <table className="md-table">
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col">Ruolo</th>
                <th scope="col">Gruppi</th>
                <th scope="col" className="md-right">
                  Attivo
                </th>
                <th scope="col">
                  <span className="md-sr-only">Azioni</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((user) => {
                const self = user.id === account.id;
                return (
                  <tr key={user.id}>
                    <td>
                      <div className="md-person">
                        <span>
                          {user.displayName}
                          {self ? " (tu)" : ""}
                        </span>
                        <small>{user.email}</small>
                      </div>
                    </td>
                    <td>
                      <label className="md-sr-only" htmlFor={`role-${user.id}`}>
                        Ruolo di {user.displayName}
                      </label>
                      <select id={`role-${user.id}`} className="md-select" value={user.role} onChange={(event) => void run(() => api.updateUser(user.id, { role: event.target.value as Role }))}>
                        {(Object.keys(ROLE_LABELS) as Role[]).map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <GroupPicker
                        label={`Gruppi di ${user.displayName}`}
                        groups={allGroups}
                        selected={user.groupIds}
                        onChange={(groupIds) => void run(() => api.updateUser(user.id, { groupIds }))}
                      />
                    </td>
                    <td className="md-right">
                      <Switch
                        checked={user.status === "active"}
                        label={`${user.displayName} attivo`}
                        disabled={self}
                        onChange={(active) => void run(() => api.updateUser(user.id, { status: active ? "active" : "disabled" }))}
                      />
                    </td>
                    <td className="md-right">
                      {self ? null : (
                        <button
                          type="button"
                          className="md-ghost md-icon-button"
                          aria-label={`Elimina ${user.displayName}`}
                          onClick={() => {
                            if (window.confirm(`Eliminare l'account di ${user.displayName}? Le sue conversazioni verranno cancellate.`)) {
                              void run(() => api.deleteUser(user.id));
                            }
                          }}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {pending.length > 0 ? (
        <Card title="Inviti in attesa" text="Ogni invito vale una volta sola. Revocalo se il link è finito alla persona sbagliata.">
          <ul className="md-plain-list">
            {pending.map((invitation) => (
              <li key={invitation.id}>
                <div className="md-person">
                  <span>
                    {invitation.displayName} · {ROLE_LABELS[invitation.role]}
                  </span>
                  <small>
                    {invitation.email} · scade {formatDate(invitation.expiresAt)}
                  </small>
                </div>
                <button type="button" className="md-outline" onClick={() => void run(() => api.revokeInvitation(invitation.id))}>
                  Revoca
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <GroupsCard groups={allGroups} users={users.data ?? []} run={run} />
    </>
  );
}

function GroupPicker({ label, groups, selected, onChange }: { label: string; groups: StoredGroup[]; selected: string[]; onChange: (ids: string[]) => void }) {
  if (groups.length === 0) return <span className="md-muted">Nessun gruppo</span>;
  const names = groups.filter((group) => selected.includes(group.id)).map((group) => group.name);
  return (
    <details className="md-group-picker">
      <summary aria-label={label}>{names.length ? names.join(", ") : "Nessuno"}</summary>
      <div className="md-menu">
        {groups.map((group) => (
          <label key={group.id} className="md-check">
            <input
              type="checkbox"
              checked={selected.includes(group.id)}
              onChange={(event) => onChange(event.target.checked ? [...selected, group.id] : selected.filter((id) => id !== group.id))}
            />
            <span>{group.name}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

/**
 * Where an invitation link must point. Opened from this computer, the page sits on 127.0.0.1,
 * which on a phone means the phone itself: the link has to use the address on the network,
 * through the device connection. Already on the network, the current address works as it is.
 */
function inviteBase(overview: DevicesOverview | undefined): string | null {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname)) return null;
  const target = overview?.connection.allowUnpairedBrowsers ? overview.connection.hosts[0] : undefined;
  return target ? `https://${target.host}:${target.port}/` : null;
}

function InviteForm({ groups, onInvited }: { groups: StoredGroup[]; onInvited: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, retry: false });
  const networkBase = inviteBase(devices.data);
  const invite = useMutation({
    mutationFn: () => api.invite({ displayName, email, role, groupIds }),
    onSuccess: async (result) => {
      setLink(`${networkBase ?? `${window.location.origin}${window.location.pathname}`}${result.acceptPath.replace(/^\//, "")}`);
      setCopied(false);
      setDisplayName("");
      setEmail("");
      setGroupIds([]);
      await onInvited();
    }
  });

  return (
    <Card title="Invita una persona" text="Crea un link personale: chi lo apre sceglie la sua password ed entra con il ruolo e i gruppi che decidi qui.">
      <form
        className="md-stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          invite.mutate();
        }}
      >
        <div className="md-inline-form">
          <label className="md-field" style={{ flex: "1 1 200px" }}>
            Nome
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={80} />
          </label>
          <label className="md-field" style={{ flex: "1 1 240px" }}>
            Email
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label className="md-field" style={{ flex: "1 1 180px" }}>
            Ruolo
            <select className="md-select" value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {(["member", "viewer", "operator", "admin"] as Role[]).map((candidate) => (
                <option key={candidate} value={candidate}>
                  {ROLE_LABELS[candidate]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="md-muted">{ROLE_HINTS[role]}</p>
        {groups.length > 0 ? (
          <fieldset className="md-chip-list">
            <legend className="md-eyebrow">Gruppi</legend>
            {groups.map((group) => (
              <label key={group.id} className="md-chip">
                <input
                  type="checkbox"
                  checked={groupIds.includes(group.id)}
                  onChange={(event) => setGroupIds(event.target.checked ? [...groupIds, group.id] : groupIds.filter((id) => id !== group.id))}
                />
                {group.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <Feedback error={invite.error} />
        <div>
          <button type="submit" className="md-primary" disabled={invite.isPending}>
            Crea il link di invito
          </button>
        </div>
      </form>
      {link ? (
        <div className="md-invite-result">
          <p>
            Manda questo link alla persona. Vale <strong>una volta sola</strong> e scade fra <strong>72 ore</strong>.
            {link.startsWith("https://")
              ? " Funziona dai dispositivi sullo stesso Wi-Fi di questo computer. Al primo accesso il browser mostrerà un avviso sul certificato: va accettato, il certificato è di ModelDock."
              : " Attenzione: questo indirizzo funziona solo su questo computer, perché la connessione fra dispositivi è spenta."}
          </p>
          <div className="md-copy-row">
            <code>{link}</code>
            <button
              type="button"
              className="md-outline"
              onClick={async () => {
                if (await copyText(link)) setCopied(true);
              }}
            >
              {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              {copied ? "Copiato" : "Copia"}
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function GroupsCard({ groups, users, run }: { groups: StoredGroup[]; users: Account[]; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [name, setName] = useState("");
  return (
    <Card title="Gruppi" text="Rinomina un gruppo scrivendo direttamente sul nome.">
      <ul className="md-plain-list">
        {groups.length === 0 ? <li className="md-muted">Ancora nessun gruppo.</li> : null}
        {groups.map((group) => {
          const members = users.filter((user) => user.groupIds.includes(group.id)).length;
          return (
            <li key={group.id}>
              <GroupName group={group} onRename={(next) => run(() => api.renameGroup(group.id, next))} />
              <small className="md-muted">
                {members} {members === 1 ? "persona" : "persone"}
              </small>
              <button
                type="button"
                className="md-ghost md-icon-button"
                aria-label={`Elimina il gruppo ${group.name}`}
                onClick={() => {
                  if (window.confirm(`Eliminare il gruppo ${group.name}? I suoi membri perdono i modelli concessi al gruppo.`)) {
                    void run(() => api.deleteGroup(group.id));
                  }
                }}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <form
        className="md-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api.createGroup(name);
            setName("");
          });
        }}
      >
        <label className="md-field" style={{ flex: "1 1 240px" }}>
          <span className="md-sr-only">Nome del nuovo gruppo</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nuovo gruppo, es. Clienti" maxLength={60} required />
        </label>
        <button type="submit" className="md-outline">
          Aggiungi gruppo
        </button>
      </form>
    </Card>
  );
}

function GroupName({ group, onRename }: { group: StoredGroup; onRename: (name: string) => Promise<void> }) {
  const [value, setValue] = useState(group.name);
  useEffect(() => setValue(group.name), [group.name]);
  const commit = () => {
    const next = value.trim();
    if (next && next !== group.name) void onRename(next);
    else setValue(group.name);
  };
  return (
    <>
      <label className="md-sr-only" htmlFor={`group-${group.id}`}>
        Nome del gruppo
      </label>
      <input
        id={`group-${group.id}`}
        className="md-inline-input"
        value={value}
        maxLength={60}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setValue(group.name);
        }}
      />
    </>
  );
}
