import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type Account } from "./chat-api.ts";
import { ChatShell } from "./ChatShell.tsx";
import "./chat.css";

export type ThemePreference = "light" | "dark";

const THEME_KEY = "modeldock.theme";

function readStoredTheme(): ThemePreference | null {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

/** The chosen theme, or the system's until the person picks one. */
export function useTheme(): [ThemePreference, () => void] {
  const [stored, setStored] = useState<ThemePreference | null>(readStoredTheme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const theme = stored ?? (systemDark ? "dark" : "light");
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setStored(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // the choice simply won't survive a reload
    }
  };
  return [theme, toggle];
}

/** The part of the hash after "#/": "", "c/<id>", "invito/<token>". */
export function useChatRoute(): string {
  const read = () => window.location.hash.replace(/^#\/?/, "");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(route: string, replace = false): void {
  const target = `#/${route}`;
  if (replace) {
    window.history.replaceState(null, "", target);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}

/** Server error codes, said the way a person would want to read them. */
export function explain(error: unknown): string {
  if (!(error instanceof ApiError)) return "Qualcosa non ha funzionato. Riprova.";
  const messages: Record<string, string> = {
    ACCOUNT_LOGIN_FAILED: "Email o password non corretti.",
    AUTH_RATE_LIMITED: "Troppi tentativi sbagliati. Riprova fra qualche minuto.",
    ACCOUNT_PASSWORD_WEAK: "La password deve avere almeno 8 caratteri e non può essere uguale all'email.",
    ACCOUNT_EMAIL_INVALID: "Questa email non sembra valida.",
    ACCOUNT_NAME_INVALID: "Scrivi un nome (al massimo 80 caratteri).",
    ACCOUNT_EMAIL_TAKEN: "Esiste già un account con questa email.",
    ACCOUNT_SETUP_DONE: "L'amministratore esiste già: accedi con il tuo account.",
    INVITATION_INVALID: "Questo link di invito non è valido.",
    INVITATION_USED: "Questo invito è già stato usato. Chiedine uno nuovo.",
    INVITATION_EXPIRED: "Questo invito è scaduto. Chiedine uno nuovo.",
    CHAT_MODEL_NOT_ALLOWED: "Questo modello non è disponibile per il tuo account.",
    CHAT_MESSAGE_INVALID: "Il messaggio è vuoto o troppo lungo.",
    CHAT_NOT_FOUND: "Questa conversazione non esiste più.",
    AUTH_REQUIRED: "La sessione è scaduta: accedi di nuovo."
  };
  return messages[error.code] ?? "Qualcosa non ha funzionato. Riprova.";
}

export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg className="md-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" />
      <path d="M7 15h10M9.5 10.5h5" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function ChatApp() {
  const [theme, toggleTheme] = useTheme();
  const route = useChatRoute();
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ["auth-state"], queryFn: api.state });

  const refresh = async () => {
    await queryClient.invalidateQueries();
  };

  let content: ReactNode;
  const inviteToken = route.startsWith("invito/") ? route.slice("invito/".length) : null;
  const signedIn = Boolean(state.data?.account);

  // Someone already signed in who opens an invitation link just lands in the chat.
  useEffect(() => {
    if (inviteToken && signedIn) navigate("", true);
  }, [inviteToken, signedIn]);

  if (state.isPending) {
    content = <div className="md-loading">Caricamento…</div>;
  } else if (state.isError) {
    content = (
      <AuthFrame title="ModelDock non risponde" text="Il server non è raggiungibile. Controlla che ModelDock sia avviato su questo computer, poi riprova.">
        <button type="button" className="md-primary" onClick={() => state.refetch()}>
          Riprova
        </button>
      </AuthFrame>
    );
  } else if (inviteToken && !state.data.account) {
    content = <InviteScreen token={inviteToken} onDone={refresh} />;
  } else if (state.data.setupRequired) {
    content = <SetupScreen onDone={refresh} />;
  } else if (!state.data.account) {
    content = <LoginScreen onDone={refresh} />;
  } else {
    content = <ChatShell account={state.data.account} route={route} theme={theme} onToggleTheme={toggleTheme} onSignedOut={refresh} />;
  }

  return (
    <div className="md-chat" data-theme={theme}>
      {content}
    </div>
  );
}

function AuthFrame({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return (
    <main className="md-auth">
      <div className="md-auth-card">
        <Mark size={40} />
        <h1>{title}</h1>
        {text ? <p>{text}</p> : null}
        {children}
      </div>
    </main>
  );
}

function useSubmit(action: () => Promise<unknown>, onDone: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
      await onDone();
    } catch (caught) {
      setError(explain(caught));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, submit };
}

function SetupScreen({ onDone }: { onDone: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { error, busy, submit } = useSubmit(() => api.setup({ displayName, email, password }), onDone);
  return (
    <AuthFrame title="Configura ModelDock" text="Crea l'account amministratore. Resta su questo computer: nessun servizio esterno.">
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label className="md-field">
          Nome
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required />
        </label>
        <label className="md-field">
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
        </label>
        <label className="md-field">
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} required />
          <small>Almeno 8 caratteri.</small>
        </label>
        {error ? <div className="md-form-error" role="alert">{error}</div> : null}
        <button type="submit" className="md-primary" disabled={busy}>
          {busy ? "Creazione…" : "Crea l'account"}
        </button>
      </form>
    </AuthFrame>
  );
}

function LoginScreen({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { error, busy, submit } = useSubmit(() => api.login({ email, password }), onDone);
  return (
    <AuthFrame title="Accedi a ModelDock">
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label className="md-field">
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
        </label>
        <label className="md-field">
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        </label>
        {error ? <div className="md-form-error" role="alert">{error}</div> : null}
        <button type="submit" className="md-primary" disabled={busy}>
          {busy ? "Accesso…" : "Accedi"}
        </button>
      </form>
    </AuthFrame>
  );
}

function InviteScreen({ token, onDone }: { token: string; onDone: () => Promise<void> }) {
  const preview = useQuery({ queryKey: ["invitation", token], queryFn: () => api.previewInvitation(token), retry: false });
  const [password, setPassword] = useState("");
  const { error, busy, submit } = useSubmit(async () => {
    await api.acceptInvitation(token, password);
    navigate("", true);
  }, onDone);

  if (preview.isPending) return <div className="md-loading">Controllo l'invito…</div>;
  if (preview.isError) {
    return (
      <AuthFrame title="Invito non valido" text={explain(preview.error)}>
        <a className="md-outline" href="#/">
          Vai all'accesso
        </a>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title={`Ciao ${preview.data.displayName}`}
      text={`Hai un invito per questo server ModelDock, con l'email ${preview.data.email}. Scegli una password per entrare.`}
    >
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label className="md-field">
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} required />
          <small>Almeno 8 caratteri.</small>
        </label>
        {error ? <div className="md-form-error" role="alert">{error}</div> : null}
        <button type="submit" className="md-primary" disabled={busy}>
          {busy ? "Un momento…" : "Entra"}
        </button>
      </form>
    </AuthFrame>
  );
}

export type { Account };
