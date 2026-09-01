import { useEffect, useState, type CSSProperties } from "react";
import { getJson, postJson, type ManagedServerSetupStatus, type TailscaleSetupStatus } from "../api.js";
import type { AppSettings, LanguagePreference } from "../types.js";

type WelcomeCopy = {
  done: string;
  next: string;
  previous: string;
  steps: Array<{
    eyebrow: string;
    title: string;
    body: string;
    primary: string;
    secondary?: string;
  }>;
};

const welcomeCopy: Record<LanguagePreference, WelcomeCopy> = {
  it: {
    done: "Fine",
    next: "Avanti",
    previous: "Indietro",
    steps: [
      {
        eyebrow: "Benvenuto",
        title: "Configuriamo il tuo AI server locale.",
        body: "ModelDock prepara automaticamente il motore dei modelli e la chat. Dovrai solamente creare l'amministratore e collegare questa macchina alla tua rete privata.",
        primary: "Inizia setup"
      },
      {
        eyebrow: "Connessione privata",
        title: "Collega il server ai tuoi dispositivi.",
        body: "La porta di accesso privata è esposta da Tailscale, un provider che permette di rendere accessibili porte alle quali possono collegarsi solo i dispositivi che selezioni.",
        primary: "Controlla Tailscale",
        secondary: "Verifica connessione"
      },
      {
        eyebrow: "Chat locale",
        title: "Prepara il tuo server AI.",
        body: "Ora crea un account amministratore esclusivamente per la chat locale. ModelDock rileva ciò che è già presente, scarica solo ciò che manca e avvia automaticamente Ollama e OpenWebUI.",
        primary: "Prepara il server",
        secondary: "Controlla stato"
      },
      {
        eyebrow: "Client",
        title: "Invita un dispositivo in modo semplicissimo.",
        body: "Il messaggio contiene già il collegamento a Tailscale e l'indirizzo della tua chat privata. Copialo e invialo alla persona che vuoi invitare.",
        primary: "Copia messaggio",
        secondary: "Vedi Dispositivi"
      },
      {
        eyebrow: "Pronto",
        title: "Ben fatto, invita altre macchine e usa la tua AI locale.",
        body: "Assicurati di essere connesso, scarica i modelli adatti al tuo computer e usa la tua AI personale, senza abbonamenti.",
        primary: "Fine"
      }
    ]
  },
  en: {
    done: "Done",
    next: "Next",
    previous: "Back",
    steps: [
      {
        eyebrow: "Welcome",
        title: "Let's set up your local AI server.",
        body: "ModelDock automatically prepares the model engine and chat. You only need to create the administrator and connect this computer to your private network.",
        primary: "Start setup"
      },
      {
        eyebrow: "Private connection",
        title: "Connect the server to your devices.",
        body: "The private access port is exposed through Tailscale, a provider that makes ports available only to the devices you select.",
        primary: "Check Tailscale",
        secondary: "Check connection"
      },
      {
        eyebrow: "Local chat",
        title: "Prepare your AI server.",
        body: "Now create an administrator account exclusively for the local chat. ModelDock detects what is already available, downloads only what is missing and automatically starts Ollama and OpenWebUI.",
        primary: "Prepare server",
        secondary: "Check status"
      },
      {
        eyebrow: "Client",
        title: "Invite a device in the simplest way.",
        body: "The message already contains the Tailscale link and your private chat address. Copy it and send it to the person you want to invite.",
        primary: "Copy message",
        secondary: "View Devices"
      },
      {
        eyebrow: "Ready",
        title: "Well done. Invite other devices and use your local AI.",
        body: "Make sure you are connected, download the models your computer can handle and use your personal AI without subscriptions.",
        primary: "Done"
      }
    ]
  }
};

export function WelcomeExperience({
  activeStep,
  copied,
  copyInvite,
  inviteMessage,
  settings,
  setActiveStep,
  updateSettings
}: {
  activeStep: number;
  chatUrl: string;
  copied: boolean;
  copyInvite(): void;
  inviteMessage: string;
  settings: AppSettings;
  setActiveStep(step: number): void;
  updateSettings(next: Partial<AppSettings>): void;
}) {
  const copy = welcomeCopy[settings.language];
  const step = copy.steps[activeStep] ?? copy.steps[0]!;
  const isFirstStep = activeStep === 0;
  const isLastStep = activeStep === copy.steps.length - 1;
  const [adminName, setAdminName] = useState(settings.openWebUIAdminName || "Admin");
  const [adminEmail, setAdminEmail] = useState(settings.openWebUIAdminEmail);
  const [adminPassword, setAdminPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [serverSetup, setServerSetup] = useState<ManagedServerSetupStatus | null>(null);
  const [isPreparingServer, setIsPreparingServer] = useState(false);
  const [tailscaleSetup, setTailscaleSetup] = useState<TailscaleSetupStatus | null>(null);
  const [tailscaleSetupMessage, setTailscaleSetupMessage] = useState<string | null>(null);
  const [isCheckingTailscale, setIsCheckingTailscale] = useState(false);

  useEffect(() => {
    if (activeStep === 1) {
      void verifyTailscaleStatus();
    } else if (activeStep === 2) {
      void refreshServerSetup();
    }
  }, [activeStep]);

  useEffect(() => {
    if (serverSetup?.state !== "running") {
      return undefined;
    }

    const interval = window.setInterval(() => void refreshServerSetup(), 2000);
    return () => window.clearInterval(interval);
  }, [serverSetup?.state]);

  function goHome() {
    updateSettings({ setupComplete: true });
    window.location.hash = "home";
  }

  async function refreshServerSetup() {
    try {
      const status = await getJson<ManagedServerSetupStatus>("/api/setup/server");
      setServerSetup(status);
      setIsPreparingServer(status.state === "running");

      if (status.state === "succeeded" && status.chatUrl) {
        updateSettings({ chatUrl: status.chatUrl });
        setAdminPassword("");
        setConfirmPassword("");
      }
    } catch {
      setFormMessage(settings.language === "it" ? "ModelDock non riesce a controllare la preparazione del server." : "ModelDock cannot check server preparation.");
    }
  }

  async function prepareServer() {
    const name = adminName.trim();
    const email = adminEmail.trim().toLowerCase();

    if (!name || !email.includes("@")) {
      setFormMessage(settings.language === "it" ? "Inserisci un nome e un indirizzo email valido." : "Enter a name and a valid email address.");
      return;
    }

    if (adminPassword.length < 8) {
      setFormMessage(settings.language === "it" ? "La password deve contenere almeno 8 caratteri." : "The password must contain at least 8 characters.");
      return;
    }

    if (adminPassword !== confirmPassword) {
      setFormMessage(settings.language === "it" ? "Le due password non coincidono." : "The two passwords do not match.");
      return;
    }

    setFormMessage(null);
    setIsPreparingServer(true);
    updateSettings({ openWebUIAdminEmail: email, openWebUIAdminName: name });

    try {
      const status = await postJson<ManagedServerSetupStatus>("/api/setup/server", {
        adminEmail: email,
        adminName: name,
        adminPassword
      });
      setServerSetup(status);
    } catch {
      setIsPreparingServer(false);
      setFormMessage(settings.language === "it" ? "Non è stato possibile avviare la preparazione. Controlla i dati e riprova." : "Server preparation could not be started. Check the details and try again.");
    }
  }

  async function verifyTailscaleStatus() {
    setIsCheckingTailscale(true);
    setTailscaleSetupMessage(null);

    try {
      const status = await getJson<TailscaleSetupStatus>("/api/setup/tailscale");
      setTailscaleSetup(status);

      if (status.suggestedServerUrl) {
        updateSettings({
          chatUrl: withPort(status.suggestedServerUrl, 8080),
          serverAccessUrl: status.suggestedServerUrl
        });
      }

      if (!status.installed) {
        setTailscaleSetupMessage(settings.language === "it" ? "Tailscale non è ancora installato su questa macchina." : "Tailscale is not installed on this computer yet.");
      } else if (!status.loggedIn) {
        setTailscaleSetupMessage(settings.language === "it" ? "Tailscale è installato. Aprilo ed effettua il login, poi verifica di nuovo." : "Tailscale is installed. Open it, sign in and check again.");
      } else {
        setTailscaleSetupMessage(
          settings.language === "it"
            ? `Connessione privata pronta${status.suggestedServerUrl ? `: ${status.suggestedServerUrl}` : "."}`
            : `Private connection ready${status.suggestedServerUrl ? `: ${status.suggestedServerUrl}` : "."}`
        );
      }
    } catch {
      setTailscaleSetupMessage(settings.language === "it" ? "ModelDock non riesce a verificare Tailscale." : "ModelDock cannot check Tailscale.");
    } finally {
      setIsCheckingTailscale(false);
    }
  }

  function runPrimaryAction() {
    if (activeStep === 0) {
      setActiveStep(1);
    } else if (activeStep === 1) {
      if (tailscaleSetup?.loggedIn) {
        setActiveStep(2);
      } else if (tailscaleSetup?.installed) {
        void startTailscaleLogin();
      } else {
        window.open("https://tailscale.com/download", "_blank", "noreferrer");
      }
    } else if (activeStep === 2) {
      if (serverSetup?.state === "succeeded") {
        setActiveStep(3);
      } else {
        void prepareServer();
      }
    } else if (activeStep === 3) {
      copyInvite();
    } else {
      goHome();
    }
  }

  function runSecondaryAction() {
    if (activeStep === 1) {
      void verifyTailscaleStatus();
    } else if (activeStep === 2) {
      void refreshServerSetup();
    } else if (activeStep === 3) {
      window.location.hash = "devices";
    }
  }

  async function startTailscaleLogin() {
    setIsCheckingTailscale(true);
    setTailscaleSetupMessage(null);

    try {
      const result = await postJson<{ message: string; started: boolean }>("/api/setup/tailscale/login", {});
      setTailscaleSetupMessage(
        result.started
          ? settings.language === "it"
            ? "Tailscale è aperto. Avvia un nuovo accesso dalla sua app e usa soltanto la nuova scheda del browser; i link aperti in precedenza possono risultare scaduti. Poi premi Verifica connessione."
            : "Tailscale is open. Start a fresh sign-in from its app and use only the new browser tab; previously opened links may be expired. Then press Check connection."
          : result.message
      );
    } catch {
      setTailscaleSetupMessage(settings.language === "it" ? "Non riesco ad aprire Tailscale. Aprilo dal computer e completa l'accesso." : "Tailscale could not be opened. Open it on this computer and complete sign-in.");
    } finally {
      setIsCheckingTailscale(false);
    }
  }

  const primaryLabel = activeStep === 1
    ? isCheckingTailscale
      ? settings.language === "it" ? "Controllo…" : "Checking…"
      : tailscaleSetup?.loggedIn
        ? copy.next
        : tailscaleSetup?.installed
          ? settings.language === "it" ? "Apri Tailscale" : "Open Tailscale"
          : settings.language === "it" ? "Scarica Tailscale" : "Download Tailscale"
    : activeStep === 2
    ? serverSetup?.state === "succeeded"
      ? copy.next
      : isPreparingServer
        ? settings.language === "it" ? "Preparazione…" : "Preparing…"
        : step.primary
    : activeStep === 3 && copied
      ? settings.language === "it" ? "Messaggio copiato" : "Message copied"
      : step.primary;
  const canAdvance = activeStep === 1
    ? tailscaleSetup?.loggedIn === true
    : activeStep === 2
      ? serverSetup?.state === "succeeded"
      : true;

  return (
    <main className="welcome-shell" aria-label={settings.language === "it" ? "Setup iniziale ModelDock" : "ModelDock initial setup"}>
      <section className="welcome-card">
        <div className="welcome-toolbar">
          <div className="brand compact-brand">
            <div className="brand-mark">M</div>
            <div>
              <strong>ModelDock</strong>
              <span>{settings.language === "it" ? "Setup guidato" : "Guided setup"}</span>
            </div>
          </div>
          <div className="welcome-toolbar-actions">
            <select aria-label={settings.language === "it" ? "Lingua" : "Language"} value={settings.language} onChange={(event) => updateSettings({ language: event.target.value as LanguagePreference })}>
              <option value="it">Italiano</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>

        <div className="welcome-progress" aria-label={settings.language === "it" ? "Avanzamento della configurazione" : "Setup progress"} style={{ "--welcome-step-count": copy.steps.length } as CSSProperties}>
          {copy.steps.map((item, index) => (
            <button aria-current={index === activeStep ? "step" : undefined} className={index === activeStep ? "active" : index < activeStep ? "done" : undefined} key={item.eyebrow} type="button" onClick={() => setActiveStep(index)}>
              <span>{index + 1}</span>
            </button>
          ))}
        </div>

        <div className="welcome-content">
          <section className="welcome-copy">
            <p className="eyebrow">{step.eyebrow}</p>
            <h1>{step.title}</h1>
            <p>{step.body}</p>

            {activeStep === 2 ? (
              <div className="welcome-server-setup">
                <div className="welcome-account-context" role="note">
                  <strong>{settings.language === "it" ? "Account amministratore della chat" : "Chat administrator account"}</strong>
                  <span>{settings.language === "it" ? "Questi dati creano un nuovo account locale per OpenWebUI. Non sono le credenziali di Tailscale." : "These details create a new local OpenWebUI account. They are not your Tailscale credentials."}</span>
                </div>
                <div className="welcome-admin-fields">
                  <label className="welcome-field">
                    <span>{settings.language === "it" ? "Nome amministratore" : "Administrator name"}</span>
                    <input autoComplete="name" value={adminName} onChange={(event) => setAdminName(event.target.value)} />
                  </label>
                  <label className="welcome-field">
                    <span>Email</span>
                    <input autoComplete="email" inputMode="email" type="email" value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} />
                  </label>
                  <label className="welcome-field">
                    <span>Password</span>
                    <input autoComplete="new-password" type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} />
                  </label>
                  <label className="welcome-field">
                    <span>{settings.language === "it" ? "Conferma password" : "Confirm password"}</span>
                    <input autoComplete="new-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
                  </label>
                </div>
                <small className="welcome-security-note">
                  {settings.language === "it"
                    ? "La password serve solo per creare l'amministratore e non viene salvata da ModelDock. Al termine resterà memorizzato soltanto l'accesso API locale."
                    : "The password is used only to create the administrator and is not stored by ModelDock. Only local API access remains saved after setup."}
                </small>
                {formMessage ? <small className="welcome-check-result warning">{formMessage}</small> : null}
                {serverSetup ? <ManagedSetupProgress language={settings.language} status={serverSetup} /> : null}
              </div>
            ) : null}

            {activeStep === 1 ? (
              <div className="welcome-field">
                <span>{settings.language === "it" ? "Accesso gestito da Tailscale" : "Sign-in handled by Tailscale"}</span>
                <small>{settings.language === "it" ? "Non inserire qui email o password. L'accesso si completa in Tailscale con Google, GitHub o il provider scelto. ModelDock verifica soltanto la connessione e rileva l'indirizzo privato." : "Do not enter an email or password here. Sign-in is completed in Tailscale using Google, GitHub or your chosen provider. ModelDock only checks the connection and detects the private address."}</small>
                {settings.serverAccessUrl.trim() ? (
                  <div className="welcome-detected-url">
                    <span>{settings.language === "it" ? "Indirizzo privato rilevato" : "Detected private address"}</span>
                    <code>{settings.serverAccessUrl}</code>
                  </div>
                ) : null}
                {tailscaleSetupMessage ? <small className={`welcome-check-result ${tailscaleSetup?.loggedIn ? "success" : "warning"}`}>{tailscaleSetupMessage}</small> : null}
              </div>
            ) : null}

            {activeStep === 3 ? (
              <label className="welcome-field welcome-invite-preview">
                <span>{settings.language === "it" ? "Messaggio da inviare" : "Message to send"}</span>
                <input aria-label={settings.language === "it" ? "Anteprima del messaggio da inviare" : "Message preview"} onFocus={(event) => event.currentTarget.select()} readOnly title={inviteMessage} value={inviteMessage} />
              </label>
            ) : null}

            <div className="welcome-actions">
              <button className="primary-button" type="button" disabled={isPreparingServer || isCheckingTailscale} onClick={runPrimaryAction}>{primaryLabel}</button>
              {!isLastStep && step.secondary ? (
                <button className="secondary-button" type="button" disabled={isPreparingServer || isCheckingTailscale} onClick={runSecondaryAction}>
                  {isCheckingTailscale && activeStep === 1 ? settings.language === "it" ? "Verifica…" : "Checking…" : step.secondary}
                </button>
              ) : null}
            </div>
          </section>
        </div>

        <footer className={`welcome-footer ${isFirstStep ? "welcome-footer-empty" : ""}`} aria-hidden={isFirstStep}>
          {!isFirstStep ? (
            <>
              <button className="ghost-step-button" type="button" onClick={() => setActiveStep(Math.max(activeStep - 1, 0))}>{copy.previous}</button>
              <button className="ghost-step-button" type="button" disabled={isPreparingServer || isCheckingTailscale || !canAdvance} onClick={isLastStep ? goHome : () => setActiveStep(Math.min(activeStep + 1, copy.steps.length - 1))}>{isLastStep ? copy.done : copy.next}</button>
            </>
          ) : null}
        </footer>
      </section>
    </main>
  );
}

function ManagedSetupProgress({ language, status }: { language: LanguagePreference; status: ManagedServerSetupStatus }) {
  const label = status.state === "succeeded"
    ? language === "it" ? "Server pronto" : "Server ready"
    : status.state === "failed"
      ? language === "it" ? "Preparazione non completata" : "Setup not completed"
      : language === "it" ? "Preparazione in corso" : "Setup in progress";

  return (
    <div className={`managed-setup-progress ${status.state}`} role="status" aria-live="polite">
      <div className="managed-setup-heading">
        <strong>{label}</strong>
        <span>{Math.round(status.progress)}%</span>
      </div>
      <div className="managed-setup-track" aria-hidden="true"><span style={{ width: `${status.progress}%` }} /></div>
      <small>{formatManagedSetupMessage(status, language)}</small>
    </div>
  );
}

function formatManagedSetupMessage(status: ManagedServerSetupStatus, language: LanguagePreference): string {
  if (status.state === "succeeded") {
    return language === "it" ? "Motore dei modelli, chat e accesso amministratore sono pronti." : "Model engine, chat and administrator access are ready.";
  }

  if (status.state === "failed") {
    return language === "it" ? `ModelDock non ha completato la preparazione. ${status.message}` : status.message;
  }

  if (status.phase === "starting_chat") {
    if (status.message.startsWith("The prepared chat start failed")) {
      return language === "it"
        ? "La chat già preparata non si è avviata. ModelDock sta usando automaticamente l'installer compatibile…"
        : "The prepared chat did not start. ModelDock is automatically using the compatible installer…";
    }

    if (status.progress < 70) {
      return language === "it" ? "Download dei componenti della chat…" : "Downloading the chat components…";
    }

    if (status.progress < 78) {
      return language === "it" ? "Installazione della chat locale. Il primo avvio può richiedere alcuni minuti…" : "Installing the local chat. The first start can take a few minutes…";
    }

    return language === "it" ? "Completamento del primo avvio. ModelDock sta ancora lavorando…" : "Finishing the first start. ModelDock is still working…";
  }

  if (status.phase === "installing_chat" && status.message.startsWith("Downloading the prepared chat runtime")) {
    const downloadPercent = status.message.match(/\((\d+)%\)/)?.[1];
    const suffix = downloadPercent ? ` ${downloadPercent}%` : "";

    return language === "it"
      ? `Download della chat già preparata…${suffix}`
      : `Downloading the prepared chat…${suffix}`;
  }

  if (status.phase === "installing_chat" && status.message.startsWith("Installing the prepared chat runtime")) {
    return language === "it" ? "Installazione della chat già verificata…" : "Installing the verified chat runtime…";
  }

  const messages: Record<ManagedServerSetupStatus["phase"], [string, string]> = {
    idle: ["In attesa.", "Waiting."],
    checking: ["Controllo dei componenti già presenti…", "Checking existing components…"],
    installing_ollama: ["Preparazione del motore dei modelli…", "Preparing the model engine…"],
    starting_ollama: ["Avvio del motore dei modelli…", "Starting the model engine…"],
    installing_chat: ["Preparazione della chat locale…", "Preparing the local chat…"],
    starting_chat: ["Primo avvio della chat…", "Starting the chat for the first time…"],
    configuring_admin: ["Configurazione dell'amministratore…", "Configuring the administrator…"],
    ready: ["Server pronto.", "Server ready."],
    failed: ["Preparazione non completata.", "Setup not completed."]
  };

  return messages[status.phase][language === "it" ? 0 : 1];
}

function withPort(value: string, port: number): string {
  try {
    const url = new URL(value);
    url.port = String(port);
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/:\d+\/?$/, `:${port}`);
  }
}
