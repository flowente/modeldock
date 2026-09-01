import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  deleteJson,
  getJson,
  postJson,
  putJson,
  type DiagnosticCheck,
  type Model,
  type ModelAccessMatrix,
  type ModelAccessPolicy,
  type ModelPullJob,
  type SystemResources,
  type SystemStatus,
  type TailnetDevice
} from "./api.js";
import { NetworkDeviceCard, TailscaleSummary } from "./components/devices.js";
import { ModelAccessRow, PullProgress } from "./components/models.js";
import { OnboardingCard } from "./components/onboarding.js";
import { DetailItem, ErrorState, PanelHeader, StatusDot, StatusTile, Warnings } from "./components/shared.js";
import { UsageAccessRow } from "./components/usage.js";
import { WelcomeExperience } from "./components/welcome.js";
import { useAppSettings } from "./hooks/use-app-settings.js";
import { useClipboard } from "./hooks/use-clipboard.js";
import { useHashRoute } from "./hooks/use-hash-route.js";
import { formatHealthStatus, formatHealthSummary } from "./lib/format.js";
import { getStringHealthDetail } from "./lib/health.js";
import { getPullFeedback, isPullJobActive, isPullJobTerminal } from "./lib/pull-jobs.js";
import { DEFAULT_SETTINGS, type BackgroundPreference, type LanguagePreference, type ModelRuntimeAction, type UpdateModelAccessInput } from "./types.js";

const uiCopy = {
  en: {
    brandSubtitle: "Local LLM control plane",
    copyServerUrl: "Copy shareable server URL",
    copied: "Copied",
    copy: "Copy",
    dashboard: "Dashboard",
    devices: "Devices",
    diagnostics: "Diagnostics",
    home: "Home",
    models: "Models",
    onboarding: "Guided setup",
    settings: "Settings",
    usage: "Usage",
    nodeOverview: "Node overview",
    compactView: "The compact view of your local AI server.",
    loadedModels: "Loaded models",
    enabledModels: "Enabled models",
    devicesOnline: "Devices online",
    chatUrl: "Chat URL",
    settingsSubtitle: "Server identity, Open WebUI entry point and local interface preferences.",
    serverIdentity: "Server identity",
    serverIdentityTitle: "How this AI server appears",
    serverIdentityText: "Use a friendly name so onboarding messages and the dashboard title feel familiar.",
    serverName: "Server name",
    openWebUISettings: "Chat URL and connection",
    openWebUISettingsText: "Set the URL people will open after their device is inside Tailscale. The backend health check still uses the .env URL.",
    testConnection: "Test connection",
    testing: "Testing…",
    openChat: "Open chat",
    interface: "Interface",
    localPreferences: "Local display preferences",
    localPreferencesText: "These options are saved only in this browser, not in the server configuration.",
    language: "Language",
    background: "Background",
    serverAccessUrl: "Server URL",
    ollamaModelsPath: "Ollama models folder",
    secretsNote: "Secrets stay in the .env file. Browser preferences stay here until we add shared server-side settings."
  },
  it: {
    brandSubtitle: "Pannello LLM locale",
    copyServerUrl: "Copia URL del server",
    copied: "Copiato",
    copy: "Copia",
    dashboard: "Dashboard",
    devices: "Dispositivi",
    diagnostics: "Diagnostica",
    home: "Panoramica",
    models: "Modelli",
    onboarding: "Setup guidato",
    settings: "Impostazioni",
    usage: "Utilizzo",
    nodeOverview: "Panoramica server",
    compactView: "La vista essenziale del tuo AI server locale.",
    loadedModels: "Modelli caricati",
    enabledModels: "Modelli abilitati",
    devicesOnline: "Dispositivi online",
    chatUrl: "URL chat",
    settingsSubtitle: "Identità server, accesso Open WebUI e preferenze locali dell'interfaccia.",
    serverIdentity: "Identità server",
    serverIdentityTitle: "Come appare questo AI server",
    serverIdentityText: "Usa un nome familiare: comparirà nella dashboard e nei messaggi di invito.",
    serverName: "Nome server",
    openWebUISettings: "URL chat e connessione",
    openWebUISettingsText: "Imposta l'indirizzo che le persone apriranno dopo essere entrate in Tailscale. Il controllo backend usa ancora l'URL nel file .env.",
    testConnection: "Test connessione",
    testing: "Verifica…",
    openChat: "Apri chat",
    interface: "Interfaccia",
    localPreferences: "Preferenze locali",
    localPreferencesText: "Queste opzioni sono salvate solo in questo browser, non nella configurazione del server.",
    language: "Lingua",
    background: "Sfondo",
    serverAccessUrl: "URL server",
    ollamaModelsPath: "Cartella modelli Ollama",
    secretsNote: "I segreti restano nel file .env. Le preferenze del browser restano qui finché non aggiungiamo impostazioni condivise lato server."
  }
};

const backgroundLabels: Record<BackgroundPreference, { en: string; it: string }> = {
  graphite: { en: "Graphite glass", it: "Vetro grafite" },
  mint: { en: "Soft mint", it: "Menta tenue" },
  sand: { en: "Paper warm", it: "Carta calda" },
  warm: { en: "Flowente paper", it: "Carta Flowente" }
};

export function App() {
  const queryClient = useQueryClient();
  const activeView = useHashRoute();
  const { settings, updateSettings } = useAppSettings();
  const tr = (english: string, italian: string) => settings.language === "it" ? italian : english;
  const serverUrlClipboard = useClipboard();
  const chatUrlClipboard = useClipboard();
  const onboardingClipboard = useClipboard();
  const deviceInviteClipboard = useClipboard();
  const [welcomeStep, setWelcomeStep] = useState(0);
  const [pullModelName, setPullModelName] = useState("mistral:7b");
  const [activePullJobId, setActivePullJobId] = useState<string | null>(null);
  const [modelActionMessage, setModelActionMessage] = useState<string | null>(null);
  const serverUrl = typeof window === "undefined" ? "http://127.0.0.1:4173" : window.location.origin;
  const system = useQuery({ queryKey: ["system"], queryFn: () => getJson<SystemStatus>("/api/system/status") });
  const resources = useQuery({ queryKey: ["system-resources"], queryFn: () => getJson<SystemResources>("/api/system/resources") });
  const models = useQuery({ queryKey: ["models"], queryFn: () => getJson<Model[]>("/api/models") });
  const accessMatrix = useQuery({ queryKey: ["model-access"], queryFn: () => getJson<ModelAccessMatrix>("/api/access/model-policies") });
  const devices = useQuery({ queryKey: ["tailscale-devices"], queryFn: () => getJson<TailnetDevice[]>("/api/network/tailscale/devices") });
  const checks = useQuery({ queryKey: ["diagnostic-checks"], queryFn: () => getJson<DiagnosticCheck[]>("/api/diagnostics/checks") });
  const activePullJob = useQuery({
    enabled: activePullJobId !== null,
    queryKey: ["model-pull-job", activePullJobId],
    queryFn: () => getJson<ModelPullJob>(`/api/models/pull-jobs/${encodeURIComponent(activePullJobId ?? "")}`),
    refetchInterval: (query) => (isPullJobTerminal(query.state.data) ? false : 700)
  });

  const updateModelAccess = useMutation({
    mutationFn: (input: UpdateModelAccessInput) => putJson<ModelAccessPolicy>("/api/access/model-policies", input),
    onSuccess: () => {
      void invalidateModelQueries();
    }
  });
  const updateDeviceAccess = useMutation({
    mutationFn: (input: { deviceId: string; authorized: boolean }) =>
      putJson<TailnetDevice>(`/api/network/tailscale/devices/${encodeURIComponent(input.deviceId)}`, { authorized: input.authorized }),
    onSuccess: () => {
      void refreshTailscaleState();
    }
  });
  const pullModel = useMutation({
    mutationFn: (name: string) => postJson<ModelPullJob>("/api/models/pull", { name }),
    onSuccess: (job) => {
      setActivePullJobId(job.id);
      setModelActionMessage(null);
    }
  });
  const deleteModel = useMutation({
    mutationFn: (name: string) => deleteJson<{ deleted: true }>(`/api/models/${encodeURIComponent(name)}`),
    onSuccess: (_result, name) => {
      setModelActionMessage(tr(`${name} deleted successfully.`, `${name} eliminato correttamente.`));
      void invalidateModelQueries();
    }
  });
  const normalizedPullModelName = pullModelName.trim().toLowerCase();
  const pullModelExistsLocally = (models.data ?? []).some((model) => model.name.toLowerCase() === normalizedPullModelName);
  const shouldShowUnknownModelHint = normalizedPullModelName.length > 0 && !models.isLoading && !pullModelExistsLocally;

  async function invalidateModelQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["models"] }),
      queryClient.invalidateQueries({ queryKey: ["model-access"] })
    ]);
  }

  function submitModelPull(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = pullModelName.trim();

    if (!name) {
      setModelActionMessage(tr("Model name is required.", "Inserisci il nome del modello."));
      return;
    }

    setActivePullJobId(null);
    setModelActionMessage(null);
    pullModel.mutate(name);
  }

  function clearModelPull() {
    setPullModelName("");
    setActivePullJobId(null);
    setModelActionMessage(null);
    pullModel.reset();
    deleteModel.reset();
  }

  const pullJob = activePullJob.data;
  const isPullingModel = pullModel.isPending || isPullJobActive(pullJob);
  const isRefreshingRuntime = models.isFetching || accessMatrix.isFetching;
  const isRefreshingTailscale = system.isFetching || devices.isFetching;
  const tailscaleHealth = system.data?.components.tailscale;
  const canManageTailscaleDevices = getStringHealthDetail(tailscaleHealth, "mode") === "api" && tailscaleHealth?.status === "available";
  const canClearModelPull = pullModelName.length > 0 || activePullJobId !== null || modelActionMessage !== null || pullModel.isError || deleteModel.isError;
  const pullFeedback = getPullFeedback({
    deleteFailed: deleteModel.isError,
    fallbackMessage: modelActionMessage,
    isStarting: pullModel.isPending,
    pullFailed: pullModel.isError,
    pullJob,
    language: settings.language
  });
  const normalizedServerName = settings.serverName.trim() || DEFAULT_SETTINGS.serverName;
  const displayChatUrl = settings.chatUrl.trim() || serverUrl;
  const displayServerAccessUrl = settings.serverAccessUrl.trim() || serverUrl;
  const dashboardTitle = settings.language === "it" ? `AI Server di ${normalizedServerName}` : `${normalizedServerName} AI Server`;
  const copy = uiCopy[settings.language];
  const onlineDevices = (devices.data ?? []).filter((device) => device.online === true).length;
  const localModelNames = new Set((models.data ?? []).map((model) => model.name));
  const localizedGroups = (accessMatrix.data?.groups ?? []).map((group) => ({
    ...group,
    description: translateGroupDescription(group.description, settings.language),
    name: translateGroupName(group.name, settings.language)
  }));
  const localModelPolicies = (accessMatrix.data?.models ?? []).filter((policy) => localModelNames.has(policy.modelName));
  const loadedModels = localModelPolicies.filter((policy) => policy.loaded).length;
  const enabledModels = localModelPolicies.filter((policy) => policy.enabled).length;
  const openWebUIHealth = system.data?.components.openWebUI;
  const activeDevices = (devices.data ?? []).filter((device) => device.authorized);
  const usageRows = activeDevices.slice(0, 4);
  const onboardingShareText = settings.language === "it"
    ? `Ciao, ti invito a utilizzare il mio server AI. Scarica Tailscale da https://tailscale.com/download oppure, se è già installato, accedi da https://login.tailscale.com con l'account indicato dal proprietario del server. Poi apri la chat: ${displayChatUrl}`
    : `Hi, I invite you to use my AI server. Download Tailscale from https://tailscale.com/download or, if it is already installed, sign in at https://login.tailscale.com with the account provided by the server owner. Then open the chat: ${displayChatUrl}`;

  async function refreshModelRuntimeState() {
    setModelActionMessage(tr("Refreshing runtime state…", "Aggiornamento dello stato dei modelli…"));

    try {
      await invalidateModelQueries();
      setModelActionMessage(tr("Runtime state refreshed.", "Stato dei modelli aggiornato."));
    } catch {
      setModelActionMessage(tr("Runtime refresh failed.", "Aggiornamento dello stato non riuscito."));
    }
  }

  async function refreshTailscaleState() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["system"] }),
      queryClient.invalidateQueries({ queryKey: ["tailscale-devices"] })
    ]);
  }

  useEffect(() => {
    if (pullJob?.status === "succeeded") {
      setModelActionMessage(tr(`${pullJob.model} pulled successfully.`, `${pullJob.model} scaricato correttamente.`));
      void invalidateModelQueries();
    }
  }, [pullJob?.id, pullJob?.model, pullJob?.status]);

  function confirmModelDelete(name: string) {
    if (!window.confirm(tr(`Delete ${name} from ModelDock?`, `Eliminare ${name} da ModelDock?`))) {
      return;
    }

    deleteModel.mutate(name);
  }

  async function copyServerUrl() {
    await serverUrlClipboard.copy(displayServerAccessUrl);
  }

  async function copyOnboardingText() {
    await onboardingClipboard.copy(onboardingShareText);
  }

  async function copyChatUrl() {
    await chatUrlClipboard.copy(displayChatUrl);
  }

  async function testOpenWebUIConnection() {
    await queryClient.invalidateQueries({ queryKey: ["system"] });
  }

  async function copyDeviceInviteText() {
    await deviceInviteClipboard.copy(onboardingShareText);
  }

  function updateTailnetDevice(input: { deviceId: string; hostname: string; authorized: boolean }) {
    if (!input.authorized) {
      const confirmed = window.confirm(tr(`Disable ${input.hostname}? The device may lose access to the private network.`, `Disattivare ${input.hostname}? Il dispositivo potrebbe perdere l'accesso alla rete privata.`));

      if (!confirmed) {
        return;
      }
    }

    updateDeviceAccess.mutate({ deviceId: input.deviceId, authorized: input.authorized });
  }

  if (activeView === "welcome") {
    return (
      <WelcomeExperience
        activeStep={welcomeStep}
        chatUrl={displayChatUrl}
        copied={onboardingClipboard.copied}
        copyInvite={() => void copyOnboardingText()}
        inviteMessage={onboardingShareText}
        settings={settings}
        setActiveStep={setWelcomeStep}
        updateSettings={updateSettings}
      />
    );
  }

  return (
    <main className="shell">
      <aside className="sidebar" aria-label={tr("ModelDock navigation", "Navigazione ModelDock")}>
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>ModelDock</strong>
            <span>{copy.brandSubtitle}</span>
          </div>
        </div>
        <div className="server-card" aria-label={tr("ModelDock server", "Server ModelDock")}>
          <span>{tr("Server:", "Server:")}</span>
          <div className="server-row">
            <code title={displayServerAccessUrl}>{displayServerAccessUrl}</code>
            <button className={`icon-button server-copy-button ${serverUrlClipboard.copied ? "copied" : ""}`} type="button" aria-label={serverUrlClipboard.copied ? copy.copied : copy.copyServerUrl} title={serverUrlClipboard.copied ? copy.copied : copy.copyServerUrl} onClick={() => void copyServerUrl()}>
              {serverUrlClipboard.copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </button>
          </div>
        </div>
        <nav className="nav nav-primary">
          <a className={activeView === "home" ? "active" : undefined} href="#home" aria-current={activeView === "home" ? "page" : undefined}>
            <span className="nav-dot" /> {copy.home}
          </a>
          <a className={activeView === "models" ? "active" : undefined} href="#models" aria-current={activeView === "models" ? "page" : undefined}>
            <span className="nav-dot" /> {copy.models}
          </a>
          <a className={activeView === "devices" ? "active" : undefined} href="#devices" aria-current={activeView === "devices" ? "page" : undefined}>
            <span className="nav-dot" /> {copy.devices}
          </a>
          <a className={activeView === "usage" ? "active" : undefined} href="#usage" aria-current={activeView === "usage" ? "page" : undefined}>
            <span className="nav-dot" /> {copy.usage}
          </a>
          <a className={activeView === "onboarding" ? "active" : undefined} href="#onboarding" aria-current={activeView === "onboarding" ? "page" : undefined}>
            <span className="nav-dot" /> {copy.onboarding}
          </a>
          <a className={activeView === "diagnostics" ? "active" : undefined} href="#diagnostics" aria-current={activeView === "diagnostics" ? "page" : undefined}>
            <span className="nav-dot" /> {copy.diagnostics}
          </a>
        </nav>
        <nav className="nav nav-footer" aria-label={tr("Preferences", "Preferenze")}>
          <a className={activeView === "settings" ? "active" : undefined} href="#settings" aria-current={activeView === "settings" ? "page" : undefined}>
            <span className="nav-dot" /> {copy.settings}
          </a>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{copy.nodeOverview}</p>
            <h1>{dashboardTitle}</h1>
          </div>
        </header>

        {activeView === "home" ? (
          <>
            <section className="status-strip" aria-label={tr("System summary", "Riepilogo del sistema")}>
              <StatusTile language={settings.language} label="Ollama" status={system.data?.components.ollama.status} message={formatHealthSummary("Ollama", system.data?.components.ollama.status, settings.language)} />
              <StatusTile language={settings.language} label={copy.devices} status={system.data?.components.tailscale.status} message={formatHealthSummary("Tailscale", system.data?.components.tailscale.status, settings.language)} />
              <StatusTile language={settings.language} label="Open WebUI" status={system.data?.components.openWebUI.status} message={formatHealthSummary("Open WebUI", system.data?.components.openWebUI.status, settings.language)} />
            </section>

            <section id="home" className="panel">
              <PanelHeader title={copy.home} subtitle={copy.compactView} />
              {system.isError ? <ErrorState message={tr("System status is not available.", "Lo stato del sistema non è disponibile.")} /> : <Warnings language={settings.language} warnings={system.data?.warnings ?? []} />}
              <div className="home-metrics">
                <DetailItem label={copy.loadedModels} value={`${loadedModels}/${models.data?.length ?? 0}`} />
                <DetailItem label={copy.enabledModels} value={`${enabledModels}/${models.data?.length ?? 0}`} />
                <DetailItem label={copy.devicesOnline} value={`${onlineDevices}/${devices.data?.length ?? 0}`} />
                <DetailItem label={copy.chatUrl} value={displayChatUrl} />
              </div>
            </section>
          </>
        ) : null}

        {activeView === "models" ? <section id="models" className="panel">
          <PanelHeader
            title={copy.models}
            action={
              <button className="panel-action-button" disabled={isRefreshingRuntime} type="button" onClick={() => void refreshModelRuntimeState()}>
                {isRefreshingRuntime ? <span className="text-spinner" aria-hidden="true">◐</span> : null}
                {tr("Refresh runtime", "Aggiorna stato")}
              </button>
            }
          />
          <form className="model-toolbar" onSubmit={submitModelPull}>
            <div className="model-toolbar-row">
              <label className="model-pull-field">
                <span>{tr("Pull model", "Scarica modello")}</span>
                <input
                  aria-label={tr("Model name to pull", "Nome del modello da scaricare")}
                  disabled={isPullingModel}
                  onChange={(event) => setPullModelName(event.target.value)}
                  placeholder="llama3.1:8b"
                  value={pullModelName}
                />
              </label>
              <button className="secondary-button" disabled={isPullingModel} type="submit">
                {isPullingModel ? tr("Pulling…", "Download…") : tr("Pull", "Scarica")}
              </button>
              <button className="secondary-button subtle-button" disabled={!canClearModelPull || isPullingModel} type="button" onClick={clearModelPull}>
                {tr("Clear", "Pulisci")}
              </button>
              <label className="model-feedback-field">
                <span>{tr("Feedback", "Esito")}</span>
                <input aria-label={tr("Pull feedback", "Esito del download")} readOnly value={pullFeedback} />
              </label>
            </div>
            <small className="model-pull-hint">
              {shouldShowUnknownModelHint ? tr("Not in your local list. Check the exact name on ", "Non è presente nella lista locale. Controlla il nome esatto su ") : tr("Find model names on ", "Trova i nomi dei modelli su ")}
              <a href="https://ollama.com/search" rel="noreferrer" target="_blank">
                Ollama Search
              </a>
              .
            </small>
          </form>
          {isPullingModel || pullJob?.status === "failed" ? <PullProgress job={pullModel.isPending ? undefined : pullJob} language={settings.language} /> : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("Name", "Nome")}</th>
                  <th>{tr("Ram fit", "Compatibilità RAM")}</th>
                  <th>{tr("Size", "Dimensione")}</th>
                  <th className="control-column">{tr("Loaded", "Caricato")}</th>
                  <th className="control-column">{tr("Enabled", "Abilitato")}</th>
                  {localizedGroups.map((group) => (
                    <th className="control-column" key={group.id}>{group.name}</th>
                  ))}
                  <th className="control-column">{tr("Actions", "Azioni")}</th>
                </tr>
              </thead>
              <tbody>
                {(models.data ?? []).map((model) => (
                  <ModelAccessRow
                    key={model.name}
                    groups={localizedGroups}
                    isUpdating={isModelUpdatePending(updateModelAccess.isPending, updateModelAccess.variables, model.name)}
                    language={settings.language}
                    model={model}
                    onDelete={confirmModelDelete}
                    onUpdate={(input) => updateModelAccess.mutate(input)}
                    policy={accessMatrix.data?.models.find((item) => item.modelName === model.name)}
                    runtimeAction={getModelRuntimeAction(updateModelAccess.isPending, updateModelAccess.variables, model.name)}
                    isDeleting={deleteModel.isPending}
                    resources={resources.data}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="panel-note">{tr("Loaded means the model is already kept in memory. Enabled means ModelDock allows users to use it.", "Caricato indica che il modello è già mantenuto in memoria. Abilitato indica che ModelDock ne permette l'utilizzo.")}</p>
        </section> : null}

        {activeView === "devices" ? <section id="devices" className="panel">
          <PanelHeader
            title={copy.devices}
            action={
              <button className="panel-action-button" disabled={isRefreshingTailscale} type="button" onClick={() => void refreshTailscaleState()}>
                {isRefreshingTailscale ? <span className="text-spinner" aria-hidden="true">◐</span> : null}
                {tr("Refresh devices", "Aggiorna dispositivi")}
              </button>
            }
          />
          <TailscaleSummary devices={devices.data ?? []} health={tailscaleHealth} language={settings.language} />
          <div className="device-overview">
            <DetailItem label={tr("Visible devices", "Dispositivi visibili")} value={`${devices.data?.length ?? 0}`} />
            <DetailItem label={tr("Online", "Connessi")} value={`${onlineDevices}`} />
            <DetailItem label={tr("Active", "Attivi")} value={`${(devices.data ?? []).filter((device) => device.authorized).length}`} />
            <DetailItem label={tr("Network layer", "Rete privata")} value="Tailscale" />
          </div>
          <article className="invite-device-card">
            <div>
              <span className="flow-step">{tr("Invite", "Invito")}</span>
              <h3>{tr("Add a new device", "Aggiungi un dispositivo")}</h3>
              <p>{tr("Send a simple setup message to the client device. After Tailscale login, come back here and refresh Devices to approve or verify access.", "Invia al dispositivo il messaggio guidato. Dopo l'accesso a Tailscale, torna qui e aggiorna la lista per approvare o verificare l'accesso.")}</p>
            </div>
            <div className="invite-actions">
              <button className="secondary-button" type="button" onClick={() => void copyDeviceInviteText()}>
                {deviceInviteClipboard.copied ? copy.copied : tr("Copy invite", "Copia invito")}
              </button>
              <a className="link-button" href="#onboarding">
                {tr("Open guide", "Apri guida")}
              </a>
            </div>
          </article>
          {devices.isError ? <ErrorState message={tr("Tailscale devices are not available.", "I dispositivi Tailscale non sono disponibili.")} /> : null}
          {!devices.isError && (devices.data ?? []).length === 0 ? <p className="empty">{tr("No Tailscale devices available yet.", "Non sono ancora disponibili dispositivi Tailscale.")}</p> : null}
          <div className="device-grid">
            {(devices.data ?? []).map((device) => (
              <NetworkDeviceCard
                canManage={canManageTailscaleDevices}
                device={device}
                isUpdating={updateDeviceAccess.isPending}
                key={device.id}
                language={settings.language}
                onUpdate={updateTailnetDevice}
              />
            ))}
          </div>
          <p className="panel-note">
            {canManageTailscaleDevices
              ? tr("Device authorization is managed through the Tailscale API. Tailscale is the secure network layer under this page.", "L'autorizzazione dei dispositivi è gestita tramite le API di Tailscale, che costituisce la rete privata di questa sezione.")
              : tr("Device authorization changes require the Tailscale API adapter and credentials.", "Per modificare le autorizzazioni servono il collegamento API e le credenziali di Tailscale.")}
          </p>
        </section> : null}

        {activeView === "usage" ? (
          <section id="usage" className="panel">
            <PanelHeader title={copy.usage} subtitle={tr("Open WebUI entry point and the connection between devices, users and models.", "Accesso a Open WebUI e collegamento tra dispositivi, utenti e modelli.")} />
            <div className="usage-grid">
              <article className="flow-card">
                <span className="flow-step">Open WebUI</span>
                <h3>{tr("Chat entry point", "Accesso alla chat")}</h3>
                <p>{tr("Share this only with devices already connected through Tailscale. Open WebUI remains the chat surface; ModelDock keeps the control view tidy.", "Condividi questo indirizzo solo con dispositivi già collegati tramite Tailscale. Open WebUI gestisce la chat, mentre ModelDock mantiene ordinato il pannello di controllo.")}</p>
                <div className="share-row">
                  <code title={displayChatUrl}>{displayChatUrl}</code>
                  <button className="secondary-button" type="button" onClick={() => void copyChatUrl()}>
                    {chatUrlClipboard.copied ? copy.copied : copy.copy}
                  </button>
                </div>
                <a className="link-button" href={displayChatUrl} rel="noreferrer" target="_blank">
                  {copy.openChat}
                </a>
              </article>
              <article className="flow-card">
                <span className="flow-step">{tr("Status", "Stato")}</span>
                <h3>{formatHealthStatus(openWebUIHealth?.status, settings.language)}</h3>
                <p>{formatHealthSummary("Open WebUI", openWebUIHealth?.status, settings.language)}</p>
                <div className="usage-status-list">
                  <DetailItem label={tr("Private network", "Rete privata")} value={tailscaleHealth?.status === "available" ? tr("Ready", "Pronta") : tr("Check Devices", "Controlla i dispositivi")} />
                  <DetailItem label={tr("Allowed models", "Modelli consentiti")} value={`${enabledModels}`} />
                </div>
                {openWebUIHealth?.status !== "available" ? (
                  <a className="link-button" href="#settings">
                    {tr("Configure Open WebUI", "Configura Open WebUI")}
                  </a>
                ) : null}
              </article>
            </div>
            <section className="usage-access">
              <div className="usage-access-heading">
                <div>
                  <span className="flow-step">{tr("Access map", "Mappa accessi")}</span>
                  <h3>{tr("Device → Open WebUI user → Model access", "Dispositivo → Utente Open WebUI → Accesso ai modelli")}</h3>
                  <p>{tr("This is the MVP manual layer. It makes the intended access model visible before we automate Open WebUI account management.", "Questa è la gestione manuale dell'MVP: rende visibile il modello di accesso prima di automatizzare gli account Open WebUI.")}</p>
                </div>
                <a className="link-button" href="#settings">
                  {tr("Configure URL", "Configura URL")}
                </a>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{tr("Device", "Dispositivo")}</th>
                      <th>{tr("Open WebUI user", "Utente Open WebUI")}</th>
                      <th>{tr("Group", "Gruppo")}</th>
                      <th>{tr("Allowed models", "Modelli consentiti")}</th>
                      <th>{tr("Status", "Stato")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageRows.length > 0 ? (
                      usageRows.map((device, index) => (
                        <UsageAccessRow
                          device={device}
                          enabledModelCount={enabledModels}
                          groupName={translateGroupName(index === 0 ? "Admins" : index === 1 ? "Builders" : "Guests", settings.language)}
                          key={device.id}
                          language={settings.language}
                        />
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5}>
                          <span className="muted-copy">{tr("No active devices yet. Invite or approve a device first.", "Non ci sono ancora dispositivi attivi. Invita o approva prima un dispositivo.")}</span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <p className="panel-note">{tr("Next step: replace the manual Open WebUI user column with real account data when we connect its admin API or a supported configuration path.", "Prossimo passo: sostituire gli utenti Open WebUI provvisori con i dati reali ottenuti tramite le API amministrative.")}</p>
          </section>
        ) : null}

        {activeView === "onboarding" ? (
          <section id="onboarding" className="panel">
            <PanelHeader title={copy.onboarding} subtitle={tr("Two clear paths: one for the server owner, one for the client device.", "Due percorsi chiari: uno per chi gestisce il server e uno per il dispositivo client.")} />
            <div className="onboarding-split">
              <section className="onboarding-path" aria-labelledby="server-onboarding-title">
                <div className="path-heading">
                  <span className="flow-step">Server</span>
                  <div>
                    <h3 id="server-onboarding-title">{tr("Server setup", "Configura il server")}</h3>
                    <p>{tr("Use this on the machine that runs ModelDock, Ollama, Tailscale and Open WebUI.", "Segui questi passaggi sulla macchina che esegue ModelDock, Ollama, Tailscale e Open WebUI.")}</p>
                  </div>
                </div>
                <div className="onboarding-grid">
                  <OnboardingCard
                    step="1"
                    title={tr("Install Ollama", "Installa Ollama")}
                    description={tr("This is the local engine that downloads and runs your AI models.", "È il motore locale che scarica ed esegue i tuoi modelli AI.")}
                    ctaLabel={tr("Download Ollama", "Scarica Ollama")}
                    href="https://ollama.com/download"
                  />
                  <OnboardingCard
                    step="2"
                    title={tr("Install and log in to Tailscale", "Installa e accedi a Tailscale")}
                    description={tr("This puts the server inside your private network, without exposing public ports.", "Inserisce il server nella rete privata senza esporre porte pubbliche.")}
                    ctaLabel={tr("Download Tailscale", "Scarica Tailscale")}
                    href="https://tailscale.com/download"
                  />
                  <OnboardingCard
                    step="3"
                    title={tr("Connect Tailscale API", "Collega le API di Tailscale")}
                    description={tr("Add the API key in the .env file so ModelDock can read devices and manage authorization.", "Aggiungi la chiave API nel file .env per consentire a ModelDock di leggere i dispositivi e gestirne l'autorizzazione.")}
                    ctaLabel={tr("Open Settings", "Apri Impostazioni")}
                    href="#settings"
                  />
                  <OnboardingCard
                    step="4"
                    title={tr("Connect Open WebUI", "Collega Open WebUI")}
                    description={tr("Set the chat URL, then use Open WebUI for account login and the chat experience.", "Imposta l'URL della chat, poi usa Open WebUI per gli account e l'esperienza di conversazione.")}
                    ctaLabel={tr("Go to Usage", "Vai a Utilizzo")}
                    href="#usage"
                  />
                </div>
              </section>

              <section className="onboarding-path" aria-labelledby="client-onboarding-title">
                <div className="path-heading">
                  <span className="flow-step">Client</span>
                  <div>
                    <h3 id="client-onboarding-title">{tr("Invite a client", "Invita un client")}</h3>
                    <p>{tr("Use this for the phone, laptop or tablet that needs to reach the AI chat.", "Segui questi passaggi per il telefono, computer o tablet che deve raggiungere la chat AI.")}</p>
                  </div>
                </div>
                <div className="onboarding-grid">
                  <OnboardingCard
                    step="1"
                    title={tr("Send the download link", "Invia il link per il download")}
                    description={tr("The client installs Tailscale directly on their own device.", "Il client installa Tailscale direttamente sul proprio dispositivo.")}
                    ctaLabel={tr("Download Tailscale", "Scarica Tailscale")}
                    href="https://tailscale.com/download"
                  />
                  <OnboardingCard
                    step="2"
                    title={tr("Client logs in", "Il client accede")}
                    description={tr("They sign in with the account or invite you prepared for the server tailnet.", "Accede con l'account o tramite l'invito preparato per la rete Tailscale del server.")}
                    ctaLabel={tr("Open login", "Apri accesso")}
                    href="https://login.tailscale.com"
                  />
                  <OnboardingCard
                    step="3"
                    title={tr("Approve and verify", "Approva e verifica")}
                    description={tr("Refresh Devices in ModelDock and confirm the new device is visible, online and active.", "Aggiorna Dispositivi in ModelDock e verifica che il nuovo dispositivo sia visibile, connesso e attivo.")}
                    ctaLabel={tr("Go to Devices", "Vai a Dispositivi")}
                    href="#devices"
                  />
                  <OnboardingCard
                    step="4"
                    title={tr("Send the chat link", "Invia il link della chat")}
                    description={tr("Once the device is active, share the Open WebUI link and the account credentials you created there.", "Quando il dispositivo è attivo, condividi il link Open WebUI e le credenziali dell'account creato.")}
                    ctaLabel={copy.openChat}
                    href={displayChatUrl}
                  />
                </div>
              </section>
            </div>
            <div className="share-template">
              <div>
                <h3>{tr("Client message", "Messaggio per il client")}</h3>
                <p>{tr("Ready-to-send text for email, WhatsApp or Slack. Keep real passwords outside this message unless you choose another secure channel.", "Testo pronto da inviare tramite email, WhatsApp o Slack. Non inserire password reali, salvo l'uso di un canale sicuro separato.")}</p>
              </div>
              <button className="secondary-button" type="button" onClick={() => void copyOnboardingText()}>
                {onboardingClipboard.copied ? copy.copied : tr("Copy text", "Copia testo")}
              </button>
              <textarea aria-label={tr("Onboarding message", "Messaggio di configurazione")} readOnly value={onboardingShareText} />
            </div>
          </section>
        ) : null}

        {activeView === "settings" ? (
          <section id="settings" className="panel">
            <PanelHeader title={copy.settings} subtitle={copy.settingsSubtitle} />
            <div className="settings-sections">
              <section className="settings-card" aria-labelledby="server-identity-title">
                <div>
                  <span className="flow-step">{copy.serverIdentity}</span>
                  <h3 id="server-identity-title">{copy.serverIdentityTitle}</h3>
                  <p>{copy.serverIdentityText}</p>
                </div>
                <label>
                  <span>{copy.serverName}</span>
                  <input aria-label={copy.serverName} value={settings.serverName} onChange={(event) => updateSettings({ serverName: event.target.value })} />
                </label>
                <label>
                  <span>{copy.serverAccessUrl}</span>
                  <input
                    aria-label={copy.serverAccessUrl}
                    placeholder={tr("http://100.x.y.z:4173 or MagicDNS", "http://100.x.y.z:4173 oppure MagicDNS")}
                    value={settings.serverAccessUrl}
                    onChange={(event) => updateSettings({ serverAccessUrl: event.target.value })}
                  />
                </label>
                <label>
                  <span>{copy.ollamaModelsPath}</span>
                  <input aria-label={copy.ollamaModelsPath} value={settings.ollamaModelsPath} onChange={(event) => updateSettings({ ollamaModelsPath: event.target.value })} />
                </label>
              </section>

              <section className="settings-card" aria-labelledby="openwebui-settings-title">
                <div className="settings-card-heading">
                  <div>
                    <span className="flow-step">Open WebUI</span>
                    <h3 id="openwebui-settings-title">{copy.openWebUISettings}</h3>
                    <p>{copy.openWebUISettingsText}</p>
                  </div>
                  <span className={`device-status-pill ${openWebUIHealth?.status === "available" ? "online" : openWebUIHealth?.status === "not_configured" ? "unknown" : "offline"}`}>
                    {formatHealthStatus(openWebUIHealth?.status, settings.language)}
                  </span>
                </div>
                <label>
                  <span>{copy.chatUrl}</span>
                  <input
                    aria-label={tr("Open WebUI chat URL", "URL della chat Open WebUI")}
                    placeholder={tr("Example: http://100.x.y.z:8080 or your Tailscale MagicDNS URL", "Esempio: http://100.x.y.z:8080 oppure l'URL MagicDNS di Tailscale")}
                    value={settings.chatUrl}
                    onChange={(event) => updateSettings({ chatUrl: event.target.value })}
                  />
                </label>
                <div className="settings-actions">
                  <button className="secondary-button" type="button" onClick={() => void testOpenWebUIConnection()} disabled={system.isFetching}>
                    {system.isFetching ? copy.testing : copy.testConnection}
                  </button>
                  <a className="link-button" href={displayChatUrl} rel="noreferrer" target="_blank">
                    {copy.openChat}
                  </a>
                </div>
                <p className="settings-hint">{formatHealthSummary("Open WebUI", openWebUIHealth?.status, settings.language)}</p>
              </section>

              <section className="settings-card" aria-labelledby="interface-settings-title">
                <div>
                  <span className="flow-step">{copy.interface}</span>
                  <h3 id="interface-settings-title">{copy.localPreferences}</h3>
                  <p>{copy.localPreferencesText}</p>
                </div>
                <label>
                  <span>{copy.language}</span>
                  <select aria-label={copy.language} value={settings.language} onChange={(event) => updateSettings({ language: event.target.value as LanguagePreference })}>
                    <option value="it">Italiano</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <label>
                  <span>{copy.background}</span>
                  <select aria-label={copy.background} value={settings.background} onChange={(event) => updateSettings({ background: event.target.value as BackgroundPreference })}>
                    {Object.entries(backgroundLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label[settings.language]}</option>
                    ))}
                  </select>
                </label>
              </section>
            </div>
            <p className="panel-note">{copy.secretsNote}</p>
          </section>
        ) : null}

        {activeView === "diagnostics" ? <section id="diagnostics" className="panel">
          <PanelHeader title={copy.diagnostics} subtitle={tr("System checks and technical details.", "Controlli del sistema e dettagli tecnici.")} />
          <div className="check-list">
            {(checks.data ?? []).map((check) => (
              <div className="check-row" key={check.id}>
                <StatusDot on={true} label={tr(`${check.label} ready`, `${translateDiagnosticLabel(check.label)} pronto`)} />
                <span>{settings.language === "it" ? translateDiagnosticLabel(check.label) : check.label}</span>
              </div>
            ))}
          </div>
        </section> : null}

      </section>
    </main>
  );
}

function isModelUpdatePending(isPending: boolean, variables: UpdateModelAccessInput | undefined, modelName: string): boolean {
  return isPending && variables?.modelName === modelName;
}

function translateGroupName(name: string, language: LanguagePreference): string {
  if (language !== "it") return name;

  const labels: Record<string, string> = {
    Admins: "Amministratori",
    Builders: "Sviluppatori",
    Guests: "Ospiti"
  };

  return labels[name] ?? name;
}

function translateGroupDescription(description: string | undefined, language: LanguagePreference): string | undefined {
  if (!description || language !== "it") return description;

  const labels: Record<string, string> = {
    "Full operational access": "Accesso operativo completo",
    "Can use everyday local models": "Può utilizzare i modelli locali di uso quotidiano",
    "Restricted demo access": "Accesso dimostrativo limitato"
  };

  return labels[description] ?? description;
}

function translateDiagnosticLabel(label: string): string {
  const labels: Record<string, string> = {
    "Backend health": "Stato del backend",
    "Model inventory": "Inventario dei modelli",
    "Storage health": "Stato dell'archiviazione",
    "Tailscale devices": "Dispositivi Tailscale",
    "Tailscale status": "Stato di Tailscale"
  };

  return labels[label] ?? label;
}

function getModelRuntimeAction(isPending: boolean, variables: UpdateModelAccessInput | undefined, modelName: string): ModelRuntimeAction | null {
  if (!isModelUpdatePending(isPending, variables, modelName) || typeof variables?.loaded !== "boolean") {
    return null;
  }

  return variables.loaded ? "loading" : "unloading";
}
