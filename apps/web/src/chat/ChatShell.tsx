import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Server,
  Lock,
  LogOut,
  Menu,
  Moon,
  Pencil,
  Folder,
  Plus,
  Search,
  Settings as SettingsIcon,
  Square,
  Sun,
  Trash2
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, streamMessage, type Account, type ChatMessage, type ChatModel, type Conversation, type ProjectSummary, type QuickCommand, type StreamEvent } from "./chat-api.ts";
import { explain, Mark, navigate, type ThemePreference } from "./ChatApp.tsx";
import { capabilityWords, SketchWords } from "./SketchWords.tsx";
import { parseCommand, SlashMenu, useSlashMenu } from "./quick-commands.tsx";
import { NewProjectDialog } from "./project-dialog.tsx";
import { CopyButton, Markdown } from "./markdown.tsx";

const MODEL_KEY = "modeldock.model";

const ROLE_LABELS: Record<Account["role"], string> = {
  admin: "Amministratore",
  operator: "Operatore",
  viewer: "Visualizzatore",
  member: "Membro"
};

const PROJECT_KEY = "modeldock-project";

const SUGGESTIONS = ["Riassumi un testo", "Scrivi un'email", "Spiegami un concetto", "Aiutami con del codice"];

interface PendingTurn {
  /** The conversation this turn belongs to; unknown until the server creates it. */
  conversationId?: string;
  /** Set once the server has saved the question, so the saved copy is not shown twice. */
  userMessageId?: string;
  /** Same for the reply, once it is complete: until the live copy goes away, the saved one stays hidden. */
  assistantMessageId?: string;
  userText: string;
  /** The quick command the question was sent with, shown as a label on it. */
  command?: string;
  answer: string;
  error?: string;
  /** What is happening before the first word, and since when. */
  status?: { kind: "loading" | "thinking"; since: number; expectedMs?: number; model: string };
}

interface Props {
  account: Account;
  route: string;
  theme: ThemePreference;
  onToggleTheme: () => void;
  onSignedOut: () => Promise<void>;
}

export function ChatShell({ account, route, theme, onToggleTheme, onSignedOut }: Props) {
  const queryClient = useQueryClient();
  const conversationId = route.startsWith("c/") ? decodeURIComponent(route.slice(2)) : undefined;
  const [search, setSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stopRef = useRef<AbortController | null>(null);

  const commands = useQuery({ queryKey: ["quick-commands"], queryFn: api.commands });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  // The project new chats start in, and whose conversations the sidebar shows. Remembered.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(PROJECT_KEY);
    } catch {
      return null;
    }
  });
  const models = useQuery({
    queryKey: ["chat-models"],
    queryFn: api.models,
    // While a model loads, look more often so the dot turns green soon after it is ready.
    refetchInterval: (query) => (query.state.data?.some((candidate) => candidate.state === "loading") ? 2000 : 15_000)
  });
  const knownProjects = projects.data ?? [];
  // A remembered project that is gone (deleted, or taken away) is simply not active.
  const activeProject = knownProjects.find((project) => project.id === activeProjectId);
  const conversations = useQuery({
    queryKey: ["conversations", search, activeProject?.id ?? null],
    queryFn: () => api.conversations(search, activeProject?.id ?? null),
    enabled: !projects.isPending
  });
  const detail = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.conversation(conversationId!),
    enabled: Boolean(conversationId),
    retry: false
  });

  const [chosenModel, setChosenModel] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(MODEL_KEY);
    } catch {
      return null;
    }
  });
  // A model picked inside an open conversation applies to its next message. Without this the
  // conversation's own model always won, and the picker snapped back to it.
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);
  const available = models.data ?? [];
  const model = pickModel(available, switchedTo ?? detail.data?.conversation.model, chosenModel);
  const currentModel = available.find((candidate) => candidate.name === model);
  // An open conversation shows its own project; a new one, the active project.
  const openProjectId = conversationId ? detail.data?.conversation.projectId : activeProject?.id;
  const currentProject = knownProjects.find((project) => project.id === openProjectId);
  // A server from before this field sends none: the words fall back to the ones every model has.
  const capabilities = currentModel?.capabilities ?? [];
  const capabilityKey = capabilities.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sketchWords = useMemo(() => capabilityWords(capabilities), [capabilityKey]);
  /** Starts loading a model now, so the wait is under way while the question is typed. */
  const warm = (name: string | undefined) => {
    const target = available.find((candidate) => candidate.name === name);
    if (!target || target.state === "ready" || target.state === "loading") return;
    void api
      .warmModel(target.name)
      .catch(() => undefined)
      .finally(() => void queryClient.invalidateQueries({ queryKey: ["chat-models"] }));
  };

  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const chooseProject = (id: string | null) => {
    setActiveProjectId(id);
    try {
      if (id) window.localStorage.setItem(PROJECT_KEY, id);
      else window.localStorage.removeItem(PROJECT_KEY);
    } catch {
      // not remembered after a reload, nothing else changes
    }
    const suggested = knownProjects.find((project) => project.id === id)?.model;
    if (suggested && available.some((candidate) => candidate.name === suggested)) chooseModel(suggested);
    navigate("");
  };

  const chooseModel = (name: string) => {
    warm(name);
    setSwitchedTo(name);
    setChosenModel(name);
    try {
      window.localStorage.setItem(MODEL_KEY, name);
    } catch {
      // not remembered after a reload, nothing else changes
    }
  };

  // A new route closes the phone drawer and clears messages that belonged to the previous view.
  useEffect(() => {
    setSidebarOpen(false);
    setNotice(null);
    setSwitchedTo(null);
  }, [route]);

  const streaming = pending !== null && !pending.error;

  const send = async (text: string, command?: { id: string; name: string }) => {
    const content = text.trim();
    if (!content || !model || streaming) return;
    const controller = new AbortController();
    stopRef.current = controller;
    setNotice(null);
    let targetId = conversationId;
    setPending({ conversationId: targetId, userText: content, answer: "", ...(command ? { command: command.name } : {}) });

    const onEvent = (event: StreamEvent) => {
      if (event.type === "conversation") {
        targetId = event.conversation.id;
        setPending((current) => (current ? { ...current, conversationId: targetId } : current));
        navigate(`c/${encodeURIComponent(targetId)}`, true);
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      } else if (event.type === "message") {
        setPending((current) => (current ? { ...current, userMessageId: event.message.id } : current));
      } else if (event.type === "notice") {
        setNotice(
          `${model} ha letto il massimo che riesce a tenere (${event.contextLength.toLocaleString("it-IT")} token) e ha tagliato l'inizio, dove ci sono le istruzioni del progetto: la risposta potrebbe non tenerne conto. Accorcia i testi del progetto o aumenta il contesto di Ollama.`
        );
      } else if (event.type === "status") {
        const status = { kind: event.status, since: Date.now(), model, ...(event.expectedMs ? { expectedMs: event.expectedMs } : {}) };
        setPending((current) => (current ? { ...current, status } : current));
      } else if (event.type === "delta") {
        setPending((current) => (current ? { ...current, status: undefined, answer: current.answer + event.content } : current));
      } else if (event.type === "done") {
        setPending((current) => (current ? { ...current, assistantMessageId: event.message.id } : current));
      } else if (event.type === "error") {
        if (event.message) {
          const id = event.message.id;
          setPending((current) => (current ? { ...current, assistantMessageId: id } : current));
        }
        setNotice(`La risposta si è interrotta: ${event.error.message}`);
      }
    };

    try {
      const project = !conversationId && activeProject ? { projectId: activeProject.id } : {};
      await streamMessage({ conversationId, model, content, ...(command ? { commandId: command.id } : {}), ...project }, onEvent, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        setPending((current) => (current ? { ...current, error: explain(error) } : current));
        return;
      }
    } finally {
      stopRef.current = null;
    }

    // The saved conversation now holds both messages: show those instead of the live copy.
    if (targetId) await queryClient.invalidateQueries({ queryKey: ["conversation", targetId] });
    await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    // The model has just answered, so it is in memory now.
    void queryClient.invalidateQueries({ queryKey: ["chat-models"] });
    setPending(null);
  };

  const stop = () => stopRef.current?.abort();

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    navigate("", true);
    await onSignedOut();
  };

  const showingPending = pending && (pending.conversationId === conversationId || (!pending.conversationId && !conversationId));
  // While a reply streams, the question is drawn from the live copy: leave out the saved one.
  const messages = (conversationId ? (detail.data?.messages ?? []) : []).filter(
    (message) => !(showingPending && (message.id === pending?.userMessageId || message.id === pending?.assistantMessageId))
  );
  const isEmpty = !conversationId && !showingPending;
  const canOpenDashboard = account.role !== "member";

  return (
    <div className="md-chat-frame" data-sidebar={sidebarOpen ? "open" : "closed"} style={{ display: "contents" }}>
      <Sidebar
        account={account}
        conversations={conversations.data ?? []}
        loading={conversations.isPending}
        projects={knownProjects}
        activeProjectId={activeProject?.id ?? null}
        onChooseProject={chooseProject}
        onNewProject={() => setNewProjectOpen(true)}
        activeId={conversationId}
        search={search}
        onSearch={setSearch}
        canOpenDashboard={canOpenDashboard}
        onSignOut={signOut}
        onChanged={async (removedId) => {
          if (removedId && removedId === conversationId) navigate("", true);
          await queryClient.invalidateQueries({ queryKey: ["conversations"] });
        }}
      />
      <div className="md-scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={async (project) => {
          setNewProjectOpen(false);
          await queryClient.invalidateQueries({ queryKey: ["projects"] });
          chooseProject(project.id);
        }}
      />

      <main className="md-main">
        <header className="md-topbar">
          <button type="button" className="md-ghost md-icon-button md-menu-toggle" aria-label="Apri le conversazioni" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} aria-hidden="true" />
          </button>
          <ModelPicker models={available} current={model} loading={models.isPending} onChoose={chooseModel} disabled={streaming} />
          {currentProject ? (
            <span className="md-project-chip" title={currentProject.description || currentProject.name}>
              <Folder size={14} aria-hidden="true" />
              <span>{currentProject.name}</span>
            </span>
          ) : null}
          <div className="md-topbar-spacer" />
          <span className="md-local-badge" title="Modelli e conversazioni restano su questo computer">
            <Lock size={14} aria-hidden="true" />
            <span>Locale</span>
          </span>
          <button
            type="button"
            className="md-ghost md-icon-button"
            onClick={onToggleTheme}
            aria-label={theme === "dark" ? "Passa al tema chiaro" : "Passa al tema scuro"}
          >
            {theme === "dark" ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />}
          </button>
          <button type="button" className="md-ghost md-icon-button" aria-label="Nuova chat" onClick={() => navigate("")}>
            <Plus size={20} aria-hidden="true" />
          </button>
        </header>

        {isEmpty ? (
          <section className="md-welcome">
            <Mark size={44} />
            <div className="md-welcome-title">
              <h1>Ciao {firstName(account.displayName)}, su cosa lavoriamo?</h1>
              {currentModel ? <SketchWords words={sketchWords} /> : null}
            </div>
            {activeProject ? (
              <p className="md-welcome-project">
                Nel progetto <strong>{activeProject.name}</strong>
                {activeProject.description ? ` · ${activeProject.description}` : ""}
              </p>
            ) : null}
            <Composer model={model} {...(currentModel ? { modelInfo: currentModel } : {})} onStartTyping={() => warm(model)} streaming={streaming} onSend={send} onStop={stop} noModels={!models.isPending && available.length === 0} account={account} commands={commands.data ?? []} projects={knownProjects} {...(currentProject ? { project: currentProject } : {})} projectLocked={Boolean(conversationId)} onChooseProject={chooseProject} onNewProject={() => setNewProjectOpen(true)} autoFocus />
            <div className="md-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" className="md-ghost" onClick={() => void send(suggestion)} disabled={!model}>
                  {suggestion}
                </button>
              ))}
            </div>
          </section>
        ) : (
          <>
            <Thread
              messages={messages}
              loading={Boolean(conversationId) && detail.isPending}
              missing={detail.isError}
              pending={showingPending ? pending : null}
            />
            <div className="md-composer-wrap">
              {notice ? (
                <div className="md-banner" data-tone="error" role="status">
                  {notice}
                </div>
              ) : null}
              <Composer model={model} {...(currentModel ? { modelInfo: currentModel } : {})} onStartTyping={() => warm(model)} streaming={streaming} onSend={send} onStop={stop} noModels={!models.isPending && available.length === 0} account={account} commands={commands.data ?? []} projects={knownProjects} {...(currentProject ? { project: currentProject } : {})} projectLocked={Boolean(conversationId)} onChooseProject={chooseProject} onNewProject={() => setNewProjectOpen(true)} />
              <p className="md-footnote">Le conversazioni restano su questo computer.</p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/** The conversation's own model if still allowed, else the last one chosen, else the first available. */
function pickModel(available: ChatModel[], conversationModel: string | undefined, chosen: string | null): string | undefined {
  const names = available.map((model) => model.name);
  if (conversationModel && names.includes(conversationModel)) return conversationModel;
  if (chosen && names.includes(chosen)) return chosen;
  return names[0];
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

/* ---------------------------------------------------------------- Sidebar */

function Sidebar(props: {
  account: Account;
  conversations: Conversation[];
  loading: boolean;
  projects: ProjectSummary[];
  activeProjectId: string | null;
  onChooseProject: (id: string | null) => void;
  onNewProject: () => void;
  activeId?: string;
  search: string;
  onSearch: (value: string) => void;
  canOpenDashboard: boolean;
  onSignOut: () => Promise<void>;
  onChanged: (removedId?: string) => Promise<void>;
}) {
  const groups = useMemo(() => groupByDay(props.conversations), [props.conversations]);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <aside className="md-sidebar">
      <div className="md-brand">
        <Mark />
        <span>ModelDock</span>
      </div>

      <a className="md-outline" href="#/" style={{ textDecoration: "none", color: "inherit" }}>
        <Plus size={18} aria-hidden="true" />
        Nuova chat
      </a>

      <div className="md-search">
        <label htmlFor="md-search" className="md-sr-only">
          Cerca nelle chat
        </label>
        <Search size={16} aria-hidden="true" />
        <input id="md-search" type="search" placeholder="Cerca nelle chat" value={props.search} onChange={(event) => props.onSearch(event.target.value)} />
      </div>

      <nav className="md-projects" aria-label="Progetti">
        <div className="md-projects-head">
          <div className="md-eyebrow">Progetti</div>
          <button type="button" className="md-ghost md-icon-button md-projects-add" aria-label="Nuovo progetto" onClick={props.onNewProject}>
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>
        {props.projects.length === 0 ? (
          <button type="button" className="md-project-item md-project-new" onClick={props.onNewProject}>
            <Plus size={14} aria-hidden="true" />
            <span>Crea un progetto</span>
          </button>
        ) : (
          <>
            <button type="button" className="md-project-item" aria-pressed={props.activeProjectId === null} onClick={() => props.onChooseProject(null)}>
              <span>Tutte le chat</span>
            </button>
            {props.projects.map((project) => (
              <div key={project.id} className="md-project-row">
                <button
                  type="button"
                  className="md-project-item"
                  aria-pressed={props.activeProjectId === project.id}
                  onClick={() => props.onChooseProject(project.id)}
                  title={project.description || project.name}
                >
                  <Folder size={14} aria-hidden="true" />
                  <span>{project.name}</span>
                </button>
                {project.editable ? (
                  <a className="md-ghost md-icon-button md-project-edit" href={`#/impostazioni/progetti/${encodeURIComponent(project.id)}`} aria-label={`Modifica ${project.name}`}>
                    <Pencil size={13} aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            ))}
          </>
        )}
      </nav>

      <nav className="md-history" aria-label="Conversazioni">
        {props.loading ? <p className="md-empty-note">Caricamento…</p> : null}
        {!props.loading && props.conversations.length === 0 ? (
          <p className="md-empty-note">
            {props.search ? "Nessuna conversazione trovata." : props.activeProjectId ? "Ancora nessuna chat in questo progetto." : "Le tue conversazioni appariranno qui."}
          </p>
        ) : null}
        {groups.map((group) => (
          <div key={group.label} className="md-history-group">
            <div className="md-eyebrow">{group.label}</div>
            {group.items.map((conversation) => (
              <HistoryItem
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === props.activeId}
                onChanged={props.onChanged}
                {...(!props.activeProjectId && conversation.projectId ? { projectName: props.projects.find((project) => project.id === conversation.projectId)?.name ?? "" } : {})}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="md-sidebar-footer">
        <div className="md-server-status">
          <span className="md-dot" aria-hidden="true" />
          Server attivo su questo computer
        </div>
        <div className="md-account">
          <button type="button" className="md-ghost" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-haspopup="menu">
            <span className="md-avatar" aria-hidden="true">
              {props.account.displayName.trim().charAt(0).toUpperCase()}
            </span>
            <span className="md-account-name">
              <span>{props.account.displayName}</span>
              <span>{ROLE_LABELS[props.account.role]}</span>
            </span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div className="md-menu md-menu-up" role="menu">
              <a className="md-menu-item" role="menuitem" href="#/impostazioni">
                <SettingsIcon size={16} aria-hidden="true" />
                <span>Impostazioni</span>
              </a>
              {props.canOpenDashboard ? (
                <a className="md-menu-item" role="menuitem" href="#/impostazioni/server">
                  <Server size={16} aria-hidden="true" />
                  <span>Stato del server</span>
                </a>
              ) : null}
              <button type="button" className="md-menu-item" role="menuitem" onClick={() => void props.onSignOut()}>
                <LogOut size={16} aria-hidden="true" />
                <span>Esci</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function HistoryItem({ conversation, active, onChanged, projectName }: { conversation: Conversation; active: boolean; onChanged: (removedId?: string) => Promise<void> ; projectName?: string }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setEditing(false);
    const next = title.trim();
    if (next && next !== conversation.title) {
      await api.rename(conversation.id, next).catch(() => setTitle(conversation.title));
      await onChanged();
    } else {
      setTitle(conversation.title);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Eliminare "${conversation.title}"? Non si può annullare.`)) return;
    await api.remove(conversation.id);
    await onChanged(conversation.id);
  };

  if (editing) {
    return (
      <form className="md-history-item" data-active={active} onSubmit={save}>
        <label htmlFor={`rename-${conversation.id}`} className="md-sr-only">
          Nuovo titolo
        </label>
        <input
          id={`rename-${conversation.id}`}
          value={title}
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setTitle(conversation.title);
              setEditing(false);
            }
          }}
        />
      </form>
    );
  }

  return (
    <div className="md-history-item" data-active={active}>
      <a href={`#/c/${encodeURIComponent(conversation.id)}`} aria-current={active ? "page" : undefined}>
        <span>{conversation.title}</span>
        {projectName ? <small className="md-history-project">{projectName}</small> : null}
      </a>
      <div className="md-history-actions">
        <button type="button" className="md-ghost" aria-label={`Rinomina ${conversation.title}`} onClick={() => setEditing(true)}>
          <Pencil size={14} aria-hidden="true" />
        </button>
        <button type="button" className="md-ghost" aria-label={`Elimina ${conversation.title}`} onClick={() => void remove()}>
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function groupByDay(conversations: Conversation[]): Array<{ label: string; items: Conversation[] }> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  const buckets: Array<{ label: string; from: number; items: Conversation[] }> = [
    { label: "Oggi", from: startOfToday.getTime(), items: [] },
    { label: "Ieri", from: startOfToday.getTime() - day, items: [] },
    { label: "Ultimi 7 giorni", from: startOfToday.getTime() - 7 * day, items: [] },
    { label: "Ultimi 30 giorni", from: startOfToday.getTime() - 30 * day, items: [] },
    { label: "Più vecchie", from: Number.NEGATIVE_INFINITY, items: [] }
  ];
  for (const conversation of conversations) {
    const time = Date.parse(conversation.updatedAt);
    buckets.find((bucket) => time >= bucket.from)?.items.push(conversation);
  }
  return buckets.filter((bucket) => bucket.items.length > 0);
}

/* ---------------------------------------------------------------- Model picker */

function ModelPicker(props: { models: ChatModel[]; current?: string; loading: boolean; disabled: boolean; onChoose: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | globalThis.KeyboardEvent) => {
      if (event instanceof MouseEvent && ref.current?.contains(event.target as Node)) return;
      if (event instanceof globalThis.KeyboardEvent && event.key !== "Escape") return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const current = props.models.find((model) => model.name === props.current);
  const [name, tag] = (current?.name ?? "").split(":");

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="md-ghost md-model-button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={props.disabled || props.models.length === 0}
      >
        {current ? <StateDot state={current.state} /> : null}
        {props.loading ? "…" : current ? name : "Nessun modello"}
        {tag ? <span className="md-model-size">{tag}</span> : null}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="md-menu md-menu-down" role="listbox" aria-label="Scegli il modello">
          {props.models.map((model) => (
            <button
              key={model.name}
              type="button"
              role="option"
              aria-selected={model.name === props.current}
              className="md-menu-item"
              onClick={() => {
                props.onChoose(model.name);
                setOpen(false);
              }}
            >
              <StateDot state={model.state} />
              <span className="md-model-option">
                {model.name}
                <small>{stateLabel(model)}</small>
              </span>
              <span className="md-menu-detail">{formatSize(model.sizeBytes)}</span>
              {model.name === props.current ? <Check size={16} aria-hidden="true" style={{ color: "var(--md-accent)" }} /> : <span style={{ width: 16 }} />}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Green: in memory, answers at once. Pulsing: loading. Hollow: loads with the first message. */
function StateDot({ state }: { state: ChatModel["state"] }) {
  if (!state) return null;
  return <span className="md-state-dot" data-state={state} aria-hidden="true" />;
}

function stateLabel(model: ChatModel): string {
  if (model.state === "ready") return "Pronto, in memoria";
  if (model.state === "loading") return "Si sta caricando…";
  return model.lastLoadMs ? `Da caricare, circa ${formatSeconds(model.lastLoadMs)}` : "Da caricare al primo messaggio";
}

/** Seconds since `since`, ticking: proof that something is happening. */
function useElapsed(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return since === undefined ? 0 : Math.max(0, now - since);
}

/** Before the first word: what the model is doing, for how long, and how long it took last time. */
function WaitStatus({ status }: { status: NonNullable<PendingTurn["status"]> }) {
  const elapsed = useElapsed(status.since);
  const name = status.model.replace(/:latest$/, "");
  const text =
    status.kind === "loading"
      ? status.expectedMs
        ? `Carico ${name} in memoria… la volta scorsa ci ha messo circa ${formatSeconds(status.expectedMs)}.`
        : `Carico ${name} in memoria… la prima volta può volerci anche un minuto.`
      : `${name} sta ragionando prima di rispondere…`;
  return (
    <p className="md-wait-status" role="status">
      <span className="md-wait-spinner" aria-hidden="true" />
      <span>{text}</span>
      {/* Hidden from screen readers: a status read aloud every second would be noise. */}
      <span className="md-wait-time" aria-hidden="true">
        {formatSeconds(elapsed)}
      </span>
    </p>
  );
}

/* ---------------------------------------------------------------- Thread */

function Thread({ messages, loading, missing, pending }: { messages: ChatMessage[]; loading: boolean; missing: boolean; pending: PendingTurn | null }) {
  const endRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const containerRef = useRef<HTMLElement>(null);

  // Follow the reply as it streams, unless the person has scrolled up to read.
  const onScroll = () => {
    const element = containerRef.current;
    if (element) followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };
  useEffect(() => {
    if (followRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending?.answer, pending?.userText]);

  if (missing) {
    return (
      <section className="md-thread">
        <div className="md-thread-inner">
          <p className="md-empty-note">Questa conversazione non esiste più. <a href="#/">Inizia una nuova chat</a>.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="md-thread" aria-label="Conversazione" ref={containerRef} onScroll={onScroll}>
      <div className="md-thread-inner" aria-live="polite" aria-busy={Boolean(pending && !pending.error)}>
        {loading ? <p className="md-empty-note">Caricamento…</p> : null}
        {messages.map((message) =>
          message.role === "user" ? (
            <UserMessage key={message.id} text={message.content} {...(message.command ? { command: message.command } : {})} />
          ) : (
            <AssistantMessage key={message.id} text={message.content} status={message.status} />
          )
        )}
        {pending ? (
          <>
            <UserMessage text={pending.userText} {...(pending.command ? { command: pending.command } : {})} />
            {pending.error ? (
              <div className="md-banner" data-tone="error" role="alert">
                {pending.error}
              </div>
            ) : (
              <AssistantMessage text={pending.answer} status="streaming" {...(pending.status ? { wait: pending.status } : {})} />
            )}
          </>
        ) : null}
        <div ref={endRef} />
      </div>
    </section>
  );
}

function UserMessage({ text, command }: { text: string; command?: string }) {
  return (
    <div className="md-user-message">
      {command ? <span className="md-command-chip">/{command}</span> : null}
      {text}
    </div>
  );
}

function AssistantMessage({ text, status, wait }: { text: string; status: ChatMessage["status"] | "streaming"; wait?: PendingTurn["status"] }) {
  return (
    <article className="md-assistant">
      <Mark size={26} />
      <div className="md-assistant-body">
        {text ? <Markdown text={text} /> : null}
        {status === "streaming" && wait && !text ? (
          <WaitStatus status={wait} />
        ) : status === "streaming" ? (
          <span>
            <span className="md-cursor" aria-hidden="true" />
            <span className="md-sr-only">Risposta in arrivo</span>
          </span>
        ) : (
          <div className="md-message-meta">
            {text ? <CopyButton text={text} label="Copia la risposta" compact /> : null}
            {status === "stopped" ? <span className="md-message-note">Risposta interrotta</span> : null}
            {status === "error" ? (
              <span className="md-message-note" data-tone="error">
                La risposta non è arrivata per intero
              </span>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------- Composer */

/** The model's state in words, beside its name under the message box. */
function readiness(model: ChatModel | undefined): string {
  if (model?.state === "ready") return "pronto, in memoria";
  if (model?.state === "loading") return "si sta caricando in memoria…";
  if (model?.state === "idle") {
    return model.lastLoadMs ? `si carica al primo messaggio (circa ${formatSeconds(model.lastLoadMs)})` : "si carica al primo messaggio";
  }
  return "gira su questo computer";
}

function formatSeconds(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

function Composer(props: {
  model?: string;
  /** The chosen model as the server sees it: whether it is in memory, and how long it loads. */
  modelInfo?: ChatModel;
  /** Called on the first character typed: a good moment to start loading the model. */
  onStartTyping?: () => void;
  streaming: boolean;
  noModels: boolean;
  account: Account;
  commands: QuickCommand[];
  /** Projects to start the chat in, and the one in use. */
  projects: ProjectSummary[];
  project?: ProjectSummary;
  /** In a conversation already started the project is fixed: the button only says which. */
  projectLocked: boolean;
  onChooseProject: (id: string | null) => void;
  onNewProject: () => void;
  autoFocus?: boolean;
  onSend: (text: string, command?: { id: string; name: string }) => Promise<void>;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const active = parseCommand(text, props.commands);
  const slash = useSlashMenu(text, props.commands, (name) => {
    setText(`/${name} `);
    areaRef.current?.focus();
  });

  // A click anywhere outside the message box closes its menus, the skill list included.
  const { dismiss } = slash;
  const anyMenuOpen = plusOpen || projectOpen || slash.open;
  useEffect(() => {
    if (!anyMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (formRef.current?.contains(event.target as Node)) return;
      setPlusOpen(false);
      setProjectOpen(false);
      dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [anyMenuOpen, dismiss]);

  // Grow with the text, up to the limit set in CSS.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }, [text]);

  // With a command, what goes to the model is the text after "/name"; it cannot be empty.
  const sendable = active ? active.rest.trim().length > 0 : text.trim().length > 0;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!sendable || props.streaming || !props.model) return;
    const value = active ? active.rest : text;
    setText("");
    void props.onSend(value, active ? { id: active.command.id, name: active.command.name } : undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.onKeyDown(event)) return;
    // Enter sends, Shift+Enter starts a new line. Not while an IME is composing a word.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  const hint = props.noModels
    ? props.account.role === "member"
      ? "Nessun modello è disponibile per il tuo account. Chiedi a un amministratore."
      : "Nessun modello disponibile: scaricane uno dal pannello del server."
    : props.streaming
      ? `${props.model} sta rispondendo…`
      : active
        ? `/${active.command.name} · ${active.command.description || "skill"}${active.rest.trim() ? "" : " · scrivi il testo dopo il nome della skill"}`
        : props.model
          ? `${props.model} · ${readiness(props.modelInfo)}`
          : "";

  return (
    <form ref={formRef} className="md-composer" onSubmit={submit} style={{ position: "relative" }}>
      {slash.open ? <SlashMenu {...slash} /> : null}
      <label htmlFor="md-message" className="md-sr-only">
        Messaggio
      </label>
      <textarea
        id="md-message"
        ref={areaRef}
        rows={1}
        placeholder="Scrivi un messaggio…"
        value={text}
        onChange={(event) => {
          if (!text && event.target.value) props.onStartTyping?.();
          setText(event.target.value);
        }}
        onKeyDown={onKeyDown}
        disabled={props.noModels}
        autoFocus={props.autoFocus}
      />
      <div className="md-composer-row">
        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="md-ghost md-icon-button md-plus"
            aria-label="Altro"
            aria-expanded={plusOpen}
            onClick={() => {
              setProjectOpen(false);
              setPlusOpen((value) => !value);
            }}
            disabled={props.noModels}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
          {plusOpen ? (
            <div className="md-menu md-menu-plus" role="menu">
              <button
                type="button"
                role="menuitem"
                className="md-menu-item"
                onClick={() => {
                  setPlusOpen(false);
                  setText("/");
                  areaRef.current?.focus();
                }}
              >
                <span>Skill</span>
                <span className="md-menu-detail">/</span>
              </button>
            </div>
          ) : null}
        </div>
        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="md-ghost md-project-button"
            aria-label={props.project ? `Progetto: ${props.project.name}` : "Scegli un progetto"}
            aria-expanded={projectOpen}
            title={props.projectLocked ? "Il progetto di una chat già iniziata non si cambia" : "Progetto"}
            onClick={() => {
              setPlusOpen(false);
              setProjectOpen((value) => !value);
            }}
            disabled={props.projectLocked || props.noModels}
            data-active={Boolean(props.project)}
          >
            <Folder size={17} aria-hidden="true" />
            {props.project ? <span>{props.project.name}</span> : null}
          </button>
          {projectOpen ? (
            <div className="md-menu md-menu-plus" role="menu" aria-label="Progetto">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!props.project}
                className="md-menu-item"
                onClick={() => {
                  setProjectOpen(false);
                  props.onChooseProject(null);
                }}
              >
                <span>Nessun progetto</span>
                {!props.project ? <Check size={15} aria-hidden="true" /> : null}
              </button>
              {props.projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={props.project?.id === project.id}
                  className="md-menu-item"
                  onClick={() => {
                    setProjectOpen(false);
                    props.onChooseProject(project.id);
                  }}
                >
                  <span>{project.name}</span>
                  {props.project?.id === project.id ? <Check size={15} aria-hidden="true" /> : null}
                </button>
              ))}
              <div className="md-menu-separator" />
              <button
                type="button"
                role="menuitem"
                className="md-menu-item"
                onClick={() => {
                  setProjectOpen(false);
                  props.onNewProject();
                }}
              >
                <span>Nuovo progetto…</span>
                <Plus size={15} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
        <span className="md-composer-hint">{hint}</span>
        {props.streaming ? (
          <button type="button" className="md-send" onClick={props.onStop} aria-label="Ferma la risposta">
            <Square size={14} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="md-send" aria-label="Invia" disabled={!sendable || !props.model}>
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    </form>
  );
}
