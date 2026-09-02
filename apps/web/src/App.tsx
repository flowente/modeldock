import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Plus, Power, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  deleteJson,
  getJson,
  postJson,
  putJson,
  type DiagnosticCheck,
  type AiServerPowerStatus,
  type Model,
  type ModelAccessMatrix,
  type ModelAccessPolicy,
  type ModelPullJob,
  type SystemResources,
  type SystemStatus,
  type TailnetDevice,
  type TailnetUserInvite,
  type TailscaleApiConnectionStatus,
  type TailscaleSetupStatus
} from "./api.js";
import { DeviceTopology, NetworkDeviceCard, TailscaleSummary } from "./components/devices.js";
import { ModelAccessRow, PullProgress } from "./components/models.js";
import { OnboardingCard } from "./components/onboarding.js";
import { DetailItem, ErrorState, PanelHeader, StatusDot, StatusTile, Warnings } from "./components/shared.js";
import { UsageAccessRow } from "./components/usage.js";
import { resolveVisibleChatUrl, WelcomeExperience, withPort } from "./components/welcome.js";
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
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [tailscaleApiToken, setTailscaleApiToken] = useState("");
  const [createdInvite, setCreatedInvite] = useState<TailnetUserInvite | null>(null);
  const serverUrl = typeof window === "undefined" ? "http://127.0.0.1:4173" : window.location.origin;
  const system = useQuery({ queryKey: ["system"], queryFn: () => getJson<SystemStatus>("/api/system/status") });
  const serverPower = useQuery({
    queryKey: ["server-power"],
    queryFn: () => getJson<AiServerPowerStatus>("/api/server/power"),
    refetchInterval: 5000
  });
  const resources = useQuery({ queryKey: ["system-resources"], queryFn: () => getJson<SystemResources>("/api/system/resources") });
  const models = useQuery({ queryKey: ["models"], queryFn: () => getJson<Model[]>("/api/models") });
  const accessMatrix = useQuery({ queryKey: ["model-access"], queryFn: () => getJson<ModelAccessMatrix>("/api/access/model-policies") });
  const devices = useQuery({ queryKey: ["tailscale-devices"], queryFn: () => getJson<TailnetDevice[]>("/api/network/tailscale/devices") });
  const tailscaleApiConnection = useQuery({
    queryKey: ["tailscale-api-connection"],
    queryFn: () => getJson<TailscaleApiConnectionStatus>("/api/settings/tailscale-api")
  });
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
  const changeServerPower = useMutation({
    mutationFn: (action: "start" | "stop") => postJson<AiServerPowerStatus>(`/api/server/power/${action}`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["server-power"] }),
        queryClient.invalidateQueries({ queryKey: ["system"] }),
        queryClient.invalidateQueries({ queryKey: ["models"] })
      ]);
    }
  });
  const createDeviceInvite = useMutation({
    mutationFn: (email: string) => postJson<TailnetUserInvite>("/api/network/tailscale/invites", { email: email.trim() || undefined }),
    onSuccess: (invite) => setCreatedInvite(invite)
  });
  const connectTailscaleApi = useMutation({
    mutationFn: (apiToken: string) => postJson<TailscaleApiConnectionStatus>("/api/settings/tailscale-api", { apiToken }),
    onSuccess: async () => {
      setTailscaleApiToken("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tailscale-api-connection"] }),
        queryClient.invalidateQueries({ queryKey: ["tailscale-devices"] }),
        queryClient.invalidateQueries({ queryKey: ["system"] })
      ]);
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
  const canManageTailscaleDevices = tailscaleApiConnection.data?.connected === true;
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
  const serverPowerState = serverPower.data?.state ?? (openWebUIHealth?.status === "available" ? "on" : "off");
  const isServerPowerBusy = changeServerPower.isPending || serverPowerState === "starting" || serverPowerState === "stopping";
  const activeDevices = (devices.data ?? []).filter((device) => device.authorized);
  const usageRows = activeDevices.slice(0, 4);
  const localHostname = getStringHealthDetail(tailscaleHealth, "hostname")?.toLowerCase();
  const serverAccessHostname = readUrlHostname(displayServerAccessUrl)?.toLowerCase();
  const serverDevice = (devices.data ?? []).find((device) => {
    const deviceHostname = device.hostname.toLowerCase();

    return deviceHostname === localHostname
      || device.addresses.some((address) => address.toLowerCase() === serverAccessHostname)
      || deviceHostname === serverAccessHostname
      || serverAccessHostname?.startsWith(`${deviceHostname}.`) === true;
  });
  const clientDevices = (devices.data ?? []).filter((device) => device.id !== serverDevice?.id);
  const selectedDevice = clientDevices.find((device) => device.id === selectedDeviceId) ?? clientDevices[0];
  const onboardingShareText = settings.language === "it"
    ? `Ciao, ti invito a utilizzare il mio server AI. Installa Tailscale da https://tailscale.com/download, accetta il link personale che ti invierò e accedi con il tuo account. Poi apri la chat: ${displayChatUrl}`
    : `Hi, I invite you to use my AI server. Install Tailscale from https://tailscale.com/download, accept the personal link I will send you and sign in with your own account. Then open the chat: ${displayChatUrl}`;
  const generatedInviteMessage = createdInvite
    ? buildDeviceInviteMessage(createdInvite, displayChatUrl, settings.language)
    : "";

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

  useEffect(() => {
    if (!settings.setupComplete || !settings.chatUrl.trim()) {
      return undefined;
    }

    let cancelled = false;

    void getJson<TailscaleSetupStatus>("/api/setup/tailscale")
      .then((status) => {
        if (cancelled || !status.loggedIn || !status.suggestedServerUrl) {
          return;
        }

        const detectedPrivateChatUrl = withPort(status.suggestedServerUrl, 8080);
        const resolvedChatUrl = resolveVisibleChatUrl(settings.chatUrl, detectedPrivateChatUrl);

        if (resolvedChatUrl !== settings.chatUrl) {
          updateSettings({ chatUrl: resolvedChatUrl, serverAccessUrl: status.suggestedServerUrl });
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [settings.chatUrl, settings.setupComplete, updateSettings]);

  useEffect(() => {
    if (selectedDevice && selectedDevice.id !== selectedDeviceId) {
      setSelectedDeviceId(selectedDevice.id);
    }
  }, [selectedDevice?.id, selectedDeviceId]);

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
    await deviceInviteClipboard.copy(generatedInviteMessage || onboardingShareText);
  }

  function openDeviceInvite() {
    setInviteEmail("");
    setCreatedInvite(null);
    createDeviceInvite.reset();
    setIsInviteOpen(true);
  }

  function toggleAiServer() {
    changeServerPower.mutate(serverPowerState === "on" ? "stop" : "start");
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
          <button
            aria-label={serverPowerState === "on" ? tr("Turn off AI services", "Spegni i servizi AI") : tr("Turn on AI services", "Accendi i servizi AI")}
            className={`server-power-button ${serverPowerState}`}
            disabled={isServerPowerBusy}
            onClick={toggleAiServer}
            type="button"
          >
            <Power aria-hidden="true" />
            <span>
              {isServerPowerBusy
                ? serverPowerState === "stopping"
                  ? tr("Stopping…", "Spegnimento…")
                  : tr("Starting…", "Avvio…")
                : serverPowerState === "on"
                  ? tr("Turn off AI", "Spegni AI")
                  : tr("Turn on AI", "Accendi AI")}
            </span>
          </button>
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
              <div className="panel-actions">
                <button className="primary-compact-button" onClick={openDeviceInvite} type="button">
                  <Plus aria-hidden="true" /> {tr("Invite device", "Invita dispositivo")}
                </button>
                <button className="panel-action-button" disabled={isRefreshingTailscale} type="button" onClick={() => void refreshTailscaleState()}>
                  {isRefreshingTailscale ? <span className="text-spinner" aria-hidden="true">◐</span> : null}
                  {tr("Refresh", "Aggiorna")}
                </button>
              </div>
            }
          />
          {devices.isError ? <ErrorState message={tr("Tailscale devices are not available.", "I dispositivi Tailscale non sono disponibili.")} /> : null}
          <div className="devices-layout">
            <DeviceTopology
              devices={devices.data ?? []}
              health={tailscaleHealth}
              language={settings.language}
              onSelect={setSelectedDeviceId}
              selectedDeviceId={selectedDevice?.id}
              serverDeviceId={serverDevice?.id}
            />
            <div className="devices-detail-column">
              <TailscaleSummary devices={devices.data ?? []} health={tailscaleHealth} language={settings.language} />
              {selectedDevice ? (
                <section className="selected-device-panel">
                  <span className="flow-step">{tr("Selected device", "Dispositivo selezionato")}</span>
                  <NetworkDeviceCard
                    canManage={canManageTailscaleDevices}
                    device={selectedDevice}
                    isUpdating={updateDeviceAccess.isPending}
                    language={settings.language}
                    onUpdate={updateTailnetDevice}
                  />
                </section>
              ) : (
                <article className="device-detail-empty">
                  <h3>{tr("No client selected", "Nessun client selezionato")}</h3>
                  <p>{tr("Invite a device to add it to this private network.", "Invita un dispositivo per aggiungerlo a questa rete privata.")}</p>
                </article>
              )}
            </div>
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
      {isInviteOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setIsInviteOpen(false);
        }}>
          <section aria-labelledby="device-invite-title" aria-modal="true" className="invite-modal" role="dialog">
            <div className="modal-heading">
              <div>
                <span className="flow-step">Tailscale</span>
                <h2 id="device-invite-title">{tr("Invite a device", "Invita un dispositivo")}</h2>
                <p>{tr("Create a personal, one-time link. The recipient signs in with their own account; ModelDock never shares your Tailscale credentials.", "Crea un link personale e monouso. La persona accederà con il proprio account: ModelDock non condivide mai le tue credenziali Tailscale.")}</p>
              </div>
              <button aria-label={tr("Close invitation", "Chiudi invito")} className="modal-close-button" onClick={() => setIsInviteOpen(false)} type="button">
                <X aria-hidden="true" />
              </button>
            </div>

            {!createdInvite && !canManageTailscaleDevices ? (
              <form className="invite-form" onSubmit={(event) => {
                event.preventDefault();
                connectTailscaleApi.mutate(tailscaleApiToken);
              }}>
                <div>
                  <h3>{tr("Connect invitations once", "Collega gli inviti una sola volta")}</h3>
                  <p className="invite-security-note">{tr("Paste a Tailscale API key. It is stored only in the local .env file and is never included in invitation messages.", "Incolla una chiave API Tailscale. Verrà salvata solamente nel file .env locale e non sarà mai inserita nei messaggi di invito.")}</p>
                </div>
                <label>
                  <span>{tr("Tailscale API key", "Chiave API Tailscale")}</span>
                  <input
                    aria-label={tr("Tailscale API key", "Chiave API Tailscale")}
                    autoComplete="off"
                    onChange={(event) => setTailscaleApiToken(event.target.value)}
                    placeholder="tskey-api-…"
                    type="password"
                    value={tailscaleApiToken}
                  />
                </label>
                <a className="inline-help-link" href="https://login.tailscale.com/admin/settings/keys" rel="noreferrer" target="_blank">
                  {tr("Create a key in Tailscale", "Crea una chiave su Tailscale")}
                </a>
                {connectTailscaleApi.isError || tailscaleApiConnection.data?.configured && !tailscaleApiConnection.data.connected ? (
                  <p className="error-copy">{tr("The key could not be verified. Check that it is active and has the required permissions.", "Non è stato possibile verificare la chiave. Controlla che sia attiva e disponga dei permessi necessari.")}</p>
                ) : null}
                <div className="modal-actions">
                  <button className="secondary-button" onClick={() => setIsInviteOpen(false)} type="button">{tr("Cancel", "Annulla")}</button>
                  <button className="primary-compact-button" disabled={connectTailscaleApi.isPending || tailscaleApiToken.trim().length < 12} type="submit">
                    {connectTailscaleApi.isPending ? tr("Checking…", "Verifica…") : tr("Connect securely", "Collega in sicurezza")}
                  </button>
                </div>
              </form>
            ) : !createdInvite ? (
              <form className="invite-form" onSubmit={(event) => {
                event.preventDefault();
                createDeviceInvite.mutate(inviteEmail);
              }}>
                <label>
                  <span>{tr("Recipient email (optional)", "Email del destinatario (facoltativa)")}</span>
                  <input
                    aria-label={tr("Recipient email", "Email del destinatario")}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="nome@email.com"
                    type="email"
                    value={inviteEmail}
                  />
                </label>
                <p className="invite-security-note">{tr("The link will add the person as a member of this private network and can be used only once.", "Il link aggiungerà la persona come membro della rete privata e potrà essere usato una sola volta.")}</p>
                {createDeviceInvite.isError ? (
                  <p className="error-copy">{tr("The invite could not be created. Check the Tailscale API key and its permissions.", "Non è stato possibile creare l'invito. Controlla la chiave API Tailscale e i relativi permessi.")}</p>
                ) : null}
                <div className="modal-actions">
                  <button className="secondary-button" onClick={() => setIsInviteOpen(false)} type="button">{tr("Cancel", "Annulla")}</button>
                  <button className="primary-compact-button" disabled={createDeviceInvite.isPending} type="submit">
                    {createDeviceInvite.isPending ? tr("Creating…", "Creazione…") : tr("Create secure invite", "Crea invito sicuro")}
                  </button>
                </div>
              </form>
            ) : (
              <div className="invite-result">
                <div className="invite-success-heading">
                  <StatusDot label={tr("Invitation ready", "Invito pronto")} on={true} />
                  <div>
                    <strong>{tr("Invitation ready", "Invito pronto")}</strong>
                    <p>{tr("Copy this message and send it by email or chat.", "Copia questo messaggio e invialo tramite email o chat.")}</p>
                  </div>
                </div>
                <textarea aria-label={tr("Invitation message", "Messaggio di invito")} readOnly value={generatedInviteMessage} />
                <div className="modal-actions">
                  <button className="secondary-button" onClick={() => {
                    setCreatedInvite(null);
                    createDeviceInvite.reset();
                  }} type="button">{tr("Create another", "Nuovo invito")}</button>
                  <button className="primary-compact-button" onClick={() => void copyDeviceInviteText()} type="button">
                    {deviceInviteClipboard.copied ? copy.copied : tr("Copy message", "Copia messaggio")}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}

function buildDeviceInviteMessage(invite: TailnetUserInvite, chatUrl: string, language: LanguagePreference): string {
  if (language === "it") {
    return `Ciao, ti invito a utilizzare il mio server AI.\n\n1. Installa Tailscale: https://tailscale.com/download\n2. Accetta questo invito personale: ${invite.inviteUrl}\n3. Accedi a Tailscale con il tuo account Google, GitHub o un altro provider.\n4. Quando la connessione è attiva, apri la chat: ${chatUrl}\n\nLe credenziali della chat ti verranno fornite separatamente.`;
  }

  return `Hi, I invite you to use my AI server.\n\n1. Install Tailscale: https://tailscale.com/download\n2. Accept this personal invitation: ${invite.inviteUrl}\n3. Sign in to Tailscale with your own Google, GitHub or another provider account.\n4. When the connection is active, open the chat: ${chatUrl}\n\nChat credentials will be provided separately.`;
}

function readUrlHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname || undefined;
  } catch {
    return undefined;
  }
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
