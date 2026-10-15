import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Check,
  ChevronDown,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Moon,
  Pencil,
  Plus,
  Search,
  Settings as SettingsIcon,
  Square,
  Sun,
  Trash2
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, streamMessage, type Account, type ChatMessage, type ChatModel, type Conversation, type StreamEvent } from "./chat-api.ts";
import { explain, Mark, navigate, type ThemePreference } from "./ChatApp.tsx";
import { CopyButton, Markdown } from "./markdown.tsx";

const MODEL_KEY = "modeldock.model";

const ROLE_LABELS: Record<Account["role"], string> = {
  admin: "Amministratore",
  operator: "Operatore",
  viewer: "Visualizzatore",
  member: "Membro"
};

const SUGGESTIONS = ["Riassumi un testo", "Scrivi un'email", "Spiegami un concetto", "Aiutami con del codice"];

interface PendingTurn {
  /** The conversation this turn belongs to; unknown until the server creates it. */
  conversationId?: string;
  /** Set once the server has saved the question, so the saved copy is not shown twice. */
  userMessageId?: string;
  userText: string;
  answer: string;
  error?: string;
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

  const models = useQuery({ queryKey: ["chat-models"], queryFn: api.models });
  const conversations = useQuery({ queryKey: ["conversations", search], queryFn: () => api.conversations(search) });
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
  const available = models.data ?? [];
  const model = pickModel(available, detail.data?.conversation.model, chosenModel);
  const chooseModel = (name: string) => {
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
  }, [route]);

  const streaming = pending !== null && !pending.error;

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || !model || streaming) return;
    const controller = new AbortController();
    stopRef.current = controller;
    setNotice(null);
    let targetId = conversationId;
    setPending({ conversationId: targetId, userText: content, answer: "" });

    const onEvent = (event: StreamEvent) => {
      if (event.type === "conversation") {
        targetId = event.conversation.id;
        setPending((current) => (current ? { ...current, conversationId: targetId } : current));
        navigate(`c/${encodeURIComponent(targetId)}`, true);
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      } else if (event.type === "message") {
        setPending((current) => (current ? { ...current, userMessageId: event.message.id } : current));
      } else if (event.type === "delta") {
        setPending((current) => (current ? { ...current, answer: current.answer + event.content } : current));
      } else if (event.type === "error") {
        setNotice(`La risposta si è interrotta: ${event.error.message}`);
      }
    };

    try {
      await streamMessage({ conversationId, model, content }, onEvent, controller.signal);
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
    (message) => !(showingPending && message.id === pending?.userMessageId)
  );
  const isEmpty = !conversationId && !showingPending;
  const canOpenDashboard = account.role !== "member";

  return (
    <div className="md-chat-frame" data-sidebar={sidebarOpen ? "open" : "closed"} style={{ display: "contents" }}>
      <Sidebar
        account={account}
        conversations={conversations.data ?? []}
        loading={conversations.isPending}
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

      <main className="md-main">
        <header className="md-topbar">
          <button type="button" className="md-ghost md-icon-button md-menu-toggle" aria-label="Apri le conversazioni" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} aria-hidden="true" />
          </button>
          <ModelPicker models={available} current={model} loading={models.isPending} onChoose={chooseModel} disabled={streaming} />
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
            <h1>Ciao {firstName(account.displayName)}, su cosa lavoriamo?</h1>
            <Composer model={model} streaming={streaming} onSend={send} onStop={stop} noModels={!models.isPending && available.length === 0} account={account} autoFocus />
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
              <Composer model={model} streaming={streaming} onSend={send} onStop={stop} noModels={!models.isPending && available.length === 0} account={account} />
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

      <nav className="md-history" aria-label="Conversazioni">
        {props.loading ? <p className="md-empty-note">Caricamento…</p> : null}
        {!props.loading && props.conversations.length === 0 ? (
          <p className="md-empty-note">{props.search ? "Nessuna conversazione trovata." : "Le tue conversazioni appariranno qui."}</p>
        ) : null}
        {groups.map((group) => (
          <div key={group.label} className="md-history-group">
            <div className="md-eyebrow">{group.label}</div>
            {group.items.map((conversation) => (
              <HistoryItem key={conversation.id} conversation={conversation} active={conversation.id === props.activeId} onChanged={props.onChanged} />
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
                <a className="md-menu-item" role="menuitem" href="#home">
                  <LayoutDashboard size={16} aria-hidden="true" />
                  <span>Pannello avanzato</span>
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

function HistoryItem({ conversation, active, onChanged }: { conversation: Conversation; active: boolean; onChanged: (removedId?: string) => Promise<void> }) {
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
              <span>{model.name}</span>
              <span className="md-menu-detail">{formatSize(model.sizeBytes)}</span>
              {model.name === props.current ? <Check size={16} aria-hidden="true" style={{ color: "var(--md-accent)" }} /> : <span style={{ width: 16 }} />}
            </button>
          ))}
        </div>
      ) : null}
    </div>
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
            <div key={message.id} className="md-user-message">
              {message.content}
            </div>
          ) : (
            <AssistantMessage key={message.id} text={message.content} status={message.status} />
          )
        )}
        {pending ? (
          <>
            <div className="md-user-message">{pending.userText}</div>
            {pending.error ? (
              <div className="md-banner" data-tone="error" role="alert">
                {pending.error}
              </div>
            ) : (
              <AssistantMessage text={pending.answer} status="streaming" />
            )}
          </>
        ) : null}
        <div ref={endRef} />
      </div>
    </section>
  );
}

function AssistantMessage({ text, status }: { text: string; status: ChatMessage["status"] | "streaming" }) {
  return (
    <article className="md-assistant">
      <Mark size={26} />
      <div className="md-assistant-body">
        {text ? <Markdown text={text} /> : null}
        {status === "streaming" ? (
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

function Composer(props: {
  model?: string;
  streaming: boolean;
  noModels: boolean;
  account: Account;
  autoFocus?: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to the limit set in CSS.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }, [text]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || props.streaming || !props.model) return;
    const value = text;
    setText("");
    void props.onSend(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter starts a new line. Not while an IME is composing a word.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  const hint = props.noModels
    ? props.account.role === "member"
      ? "Nessun modello è disponibile per il tuo account. Chiedi a un amministratore."
      : "Nessun modello disponibile: scaricane uno dal pannello del server."
    : props.streaming
      ? `${props.model} sta rispondendo…`
      : props.model
        ? `${props.model} · gira su questo computer`
        : "";

  return (
    <form className="md-composer" onSubmit={submit}>
      <label htmlFor="md-message" className="md-sr-only">
        Messaggio
      </label>
      <textarea
        id="md-message"
        ref={areaRef}
        rows={1}
        placeholder="Scrivi un messaggio…"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={props.noModels}
        autoFocus={props.autoFocus}
      />
      <div className="md-composer-row">
        <span className="md-composer-hint">{hint}</span>
        {props.streaming ? (
          <button type="button" className="md-send" onClick={props.onStop} aria-label="Ferma la risposta">
            <Square size={14} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="md-send" aria-label="Invia" disabled={!text.trim() || !props.model}>
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    </form>
  );
}
