import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Check, Copy, Database, Gauge, LifeBuoy, MonitorSmartphone, Play, RefreshCw, Server, Settings, Terminal, Users } from "lucide-react";
import {
  deleteJson,
  getJson,
  postJson,
  putJson,
  type DiagnosticCheck,
  type DiagnosticCheckResult,
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
import { DetailItem, DiagnosticResultRow, ErrorState, PanelHeader, StatusDot, StatusTile, Warnings } from "./components/shared.js";
import { UsageAccessRow } from "./components/usage.js";
import { useAppSettings } from "./hooks/use-app-settings.js";
import { useClipboard } from "./hooks/use-clipboard.js";
import { useHashRoute } from "./hooks/use-hash-route.js";
import { formatHealthStatus } from "./lib/format.js";
import { getStringHealthDetail } from "./lib/health.js";
import { getPullFeedback, isPullJobActive, isPullJobTerminal } from "./lib/pull-jobs.js";
import { DEFAULT_SETTINGS, type ModelRuntimeAction, type ThemePreference, type UpdateModelAccessInput } from "./types.js";

export function App() {
  const queryClient = useQueryClient();
  const activeView = useHashRoute();
  const { settings, updateSettings } = useAppSettings();
  const serverUrlClipboard = useClipboard();
  const chatUrlClipboard = useClipboard();
  const onboardingClipboard = useClipboard();
  const deviceInviteClipboard = useClipboard();
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

  const runDiagnostics = useMutation({
    mutationFn: () => postJson<DiagnosticCheckResult[]>("/api/diagnostics/run-all")
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
      setModelActionMessage(`${name} deleted successfully.`);
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
      setModelActionMessage("Model name is required.");
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
    pullJob
  });
  const normalizedServerName = settings.serverName.trim() || DEFAULT_SETTINGS.serverName;
  const displayChatUrl = settings.chatUrl.trim() || serverUrl;
  const dashboardTitle = `AI Server di ${normalizedServerName}`;
  const onlineDevices = (devices.data ?? []).filter((device) => device.online === true).length;
  const localModelNames = new Set((models.data ?? []).map((model) => model.name));
  const localModelPolicies = (accessMatrix.data?.models ?? []).filter((policy) => localModelNames.has(policy.modelName));
  const loadedModels = localModelPolicies.filter((policy) => policy.loaded).length;
  const enabledModels = localModelPolicies.filter((policy) => policy.enabled).length;
  const openWebUIHealth = system.data?.components.openWebUI;
  const activeDevices = (devices.data ?? []).filter((device) => device.authorized);
  const usageRows = activeDevices.slice(0, 4);
  const onboardingShareText = [
    `Ti ho invitato a usare ${dashboardTitle}.`,
    "",
    "Fai questi passaggi dal tuo dispositivo:",
    "",
    "1. Scarica Tailscale:",
    "https://tailscale.com/download",
    "",
    "2. Accedi a Tailscale con l'account indicato dal proprietario del server.",
    "",
    "3. Aspetta che il dispositivo venga approvato.",
    "",
    `4. Apri la chat AI: ${displayChatUrl}`,
    "",
    "Se non riesci a collegarti, manda al proprietario il nome del dispositivo che vedi in Tailscale."
  ].join("\n");

  async function refreshModelRuntimeState() {
    setModelActionMessage("Refreshing runtime state...");

    try {
      await invalidateModelQueries();
      setModelActionMessage("Runtime state refreshed.");
    } catch {
      setModelActionMessage("Runtime refresh failed.");
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
      setModelActionMessage(`${pullJob.model} pulled successfully.`);
      void invalidateModelQueries();
    }
  }, [pullJob?.id, pullJob?.model, pullJob?.status]);

  function confirmModelDelete(name: string) {
    if (!window.confirm(`Delete ${name} from ModelDock?`)) {
      return;
    }

    deleteModel.mutate(name);
  }

  async function copyServerUrl() {
    await serverUrlClipboard.copy(serverUrl);
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
      const confirmed = window.confirm(`Disattivare ${input.hostname}? Il device potrebbe perdere l'accesso alla rete privata.`);

      if (!confirmed) {
        return;
      }
    }

    updateDeviceAccess.mutate({ deviceId: input.deviceId, authorized: input.authorized });
  }

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="ModelDock navigation">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>ModelDock</strong>
            <span>Local LLM control plane</span>
          </div>
        </div>
        <div className="server-card" aria-label="ModelDock server">
          <span>Server:</span>
          <div className="server-row">
            <code title={serverUrl}>{serverUrl}</code>
            <button className="icon-button" type="button" aria-label="Copy shareable server URL" title="Copy shareable server URL" onClick={() => void copyServerUrl()}>
              {serverUrlClipboard.copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
        </div>
        <nav className="nav">
          <a className={activeView === "home" ? "active" : undefined} href="#home" aria-current={activeView === "home" ? "page" : undefined}>
            <Gauge size={16} /> Home
          </a>
          <a className={activeView === "models" ? "active" : undefined} href="#models" aria-current={activeView === "models" ? "page" : undefined}>
            <Database size={16} /> Models
          </a>
          <a className={activeView === "devices" ? "active" : undefined} href="#devices" aria-current={activeView === "devices" ? "page" : undefined}>
            <MonitorSmartphone size={16} /> Devices
          </a>
          <a className={activeView === "usage" ? "active" : undefined} href="#usage" aria-current={activeView === "usage" ? "page" : undefined}>
            <Users size={16} /> Usage
          </a>
          <a className={activeView === "onboarding" ? "active" : undefined} href="#onboarding" aria-current={activeView === "onboarding" ? "page" : undefined}>
            <LifeBuoy size={16} /> Onboarding
          </a>
          <a className={activeView === "settings" ? "active" : undefined} href="#settings" aria-current={activeView === "settings" ? "page" : undefined}>
            <Settings size={16} /> Settings
          </a>
          <a className={activeView === "diagnostics" ? "active" : undefined} href="#diagnostics" aria-current={activeView === "diagnostics" ? "page" : undefined}>
            <Terminal size={16} /> Diagnostics
          </a>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Node overview</p>
            <h1>{dashboardTitle}</h1>
          </div>
          <button className="primary-button" type="button" onClick={() => runDiagnostics.mutate()} disabled={runDiagnostics.isPending}>
            {runDiagnostics.isPending ? <RefreshCw className="spin" size={16} /> : <Play size={16} />}
            Run diagnostics
          </button>
        </header>

        {activeView === "home" ? (
          <>
            <section className="status-strip" aria-label="System summary">
              <StatusTile icon={<Database size={18} />} label="Ollama" status={system.data?.components.ollama.status} message={system.data?.components.ollama.message} />
              <StatusTile icon={<MonitorSmartphone size={18} />} label="Devices" status={system.data?.components.tailscale.status} message={system.data?.components.tailscale.message} />
              <StatusTile icon={<Server size={18} />} label="Open WebUI" status={system.data?.components.openWebUI.status} message={system.data?.components.openWebUI.message} />
            </section>

            <section id="home" className="panel">
              <PanelHeader title="Home" subtitle="The compact view of your local AI server." />
              {system.isError ? <ErrorState message="System status is not available." /> : <Warnings warnings={system.data?.warnings ?? []} />}
              <div className="home-metrics">
                <DetailItem label="Loaded models" value={`${loadedModels}/${models.data?.length ?? 0}`} />
                <DetailItem label="Enabled models" value={`${enabledModels}/${models.data?.length ?? 0}`} />
                <DetailItem label="Devices online" value={`${onlineDevices}/${devices.data?.length ?? 0}`} />
                <DetailItem label="Chat URL" value={displayChatUrl} />
              </div>
            </section>
          </>
        ) : null}

        {activeView === "models" ? <section id="models" className="panel">
          <PanelHeader
            title="Models"
            action={
              <button className="panel-action-button" disabled={isRefreshingRuntime} type="button" onClick={() => void refreshModelRuntimeState()}>
                <RefreshCw className={isRefreshingRuntime ? "spin" : undefined} size={15} />
                Refresh runtime
              </button>
            }
          />
          <form className="model-toolbar" onSubmit={submitModelPull}>
            <div className="model-toolbar-row">
              <label className="model-pull-field">
                <span>Pull model</span>
                <input
                  aria-label="Model name to pull"
                  disabled={isPullingModel}
                  onChange={(event) => setPullModelName(event.target.value)}
                  placeholder="llama3.1:8b"
                  value={pullModelName}
                />
              </label>
              <button className="secondary-button" disabled={isPullingModel} type="submit">
                {isPullingModel ? "Pulling…" : "Pull"}
              </button>
              <button className="secondary-button subtle-button" disabled={!canClearModelPull || isPullingModel} type="button" onClick={clearModelPull}>
                Clear
              </button>
              <label className="model-feedback-field">
                <span>Feedback</span>
                <input aria-label="Pull feedback" readOnly value={pullFeedback} />
              </label>
            </div>
            <small className="model-pull-hint">
              {shouldShowUnknownModelHint ? "Not in your local list. Check the exact name on " : "Find model names on "}
              <a href="https://ollama.com/search" rel="noreferrer" target="_blank">
                Ollama Search
              </a>
              .
            </small>
          </form>
          {isPullingModel || pullJob?.status === "failed" ? <PullProgress job={pullModel.isPending ? undefined : pullJob} /> : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Ram fit</th>
                  <th>Size</th>
                  <th className="control-column">Loaded</th>
                  <th className="control-column">Enabled</th>
                  {(accessMatrix.data?.groups ?? []).map((group) => (
                    <th className="control-column" key={group.id}>{group.name}</th>
                  ))}
                  <th className="control-column">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(models.data ?? []).map((model) => (
                  <ModelAccessRow
                    key={model.name}
                    groups={accessMatrix.data?.groups ?? []}
                    isUpdating={isModelUpdatePending(updateModelAccess.isPending, updateModelAccess.variables, model.name)}
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
          <p className="panel-note">Loaded means the model is already kept in memory. Enabled means ModelDock allows users to use it.</p>
        </section> : null}

        {activeView === "devices" ? <section id="devices" className="panel">
          <PanelHeader
            title="Devices"
            action={
              <button className="panel-action-button" disabled={isRefreshingTailscale} type="button" onClick={() => void refreshTailscaleState()}>
                <RefreshCw className={isRefreshingTailscale ? "spin" : undefined} size={15} />
                Refresh devices
              </button>
            }
          />
          <TailscaleSummary devices={devices.data ?? []} health={tailscaleHealth} />
          <div className="device-overview">
            <DetailItem label="Visible devices" value={`${devices.data?.length ?? 0}`} />
            <DetailItem label="Online" value={`${onlineDevices}`} />
            <DetailItem label="Active" value={`${(devices.data ?? []).filter((device) => device.authorized).length}`} />
            <DetailItem label="Network layer" value="Tailscale" />
          </div>
          <article className="invite-device-card">
            <div>
              <span className="flow-step">Invite</span>
              <h3>Add a new device</h3>
              <p>Send a simple setup message to the client device. After Tailscale login, come back here and refresh Devices to approve or verify access.</p>
            </div>
            <div className="invite-actions">
              <button className="secondary-button" type="button" onClick={() => void copyDeviceInviteText()}>
                {deviceInviteClipboard.copied ? "Copied" : "Copy invite"}
              </button>
              <a className="link-button" href="#onboarding">
                Open guide
              </a>
            </div>
          </article>
          {devices.isError ? <ErrorState message="Tailscale devices are not available." /> : null}
          {!devices.isError && (devices.data ?? []).length === 0 ? <p className="empty">No Tailscale devices available yet.</p> : null}
          <div className="device-grid">
            {(devices.data ?? []).map((device) => (
              <NetworkDeviceCard
                canManage={canManageTailscaleDevices}
                device={device}
                isUpdating={updateDeviceAccess.isPending}
                key={device.id}
                onUpdate={updateTailnetDevice}
              />
            ))}
          </div>
          <p className="panel-note">
            {canManageTailscaleDevices
              ? "Device authorization is managed through the Tailscale API. Tailscale is the secure network layer under this page."
              : "Device authorization changes require the Tailscale API adapter and credentials."}
          </p>
        </section> : null}

        {activeView === "usage" ? (
          <section id="usage" className="panel">
            <PanelHeader title="Usage" subtitle="Open WebUI entry point, access intent and the bridge between devices, users and models." />
            <div className="usage-grid">
              <article className="flow-card">
                <span className="flow-step">Open WebUI</span>
                <h3>Chat entry point</h3>
                <p>Share this only with devices already connected through Tailscale. Open WebUI remains the chat surface; ModelDock keeps the control view tidy.</p>
                <div className="share-row">
                  <code title={displayChatUrl}>{displayChatUrl}</code>
                  <button className="secondary-button" type="button" onClick={() => void copyChatUrl()}>
                    {chatUrlClipboard.copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <a className="link-button" href={displayChatUrl} rel="noreferrer" target="_blank">
                  Open chat
                </a>
              </article>
              <article className="flow-card">
                <span className="flow-step">Status</span>
                <h3>{formatHealthStatus(openWebUIHealth?.status)}</h3>
                <p>{openWebUIHealth?.message ?? "Open WebUI status is loading."}</p>
                <div className="usage-status-list">
                  <DetailItem label="Private network" value={tailscaleHealth?.status === "available" ? "Ready" : "Check Devices"} />
                  <DetailItem label="Allowed models" value={`${enabledModels}`} />
                </div>
                {openWebUIHealth?.status !== "available" ? (
                  <a className="link-button" href="#settings">
                    Configure Open WebUI
                  </a>
                ) : null}
              </article>
            </div>
            <section className="usage-access">
              <div className="usage-access-heading">
                <div>
                  <span className="flow-step">Access map</span>
                  <h3>Device → Open WebUI user → Model access</h3>
                  <p>This is the MVP manual layer. It makes the intended access model visible before we automate Open WebUI account management.</p>
                </div>
                <a className="link-button" href="#settings">
                  Configure URL
                </a>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Open WebUI user</th>
                      <th>Group</th>
                      <th>Allowed models</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageRows.length > 0 ? (
                      usageRows.map((device, index) => (
                        <UsageAccessRow
                          device={device}
                          enabledModelCount={enabledModels}
                          groupName={index === 0 ? "Admins" : index === 1 ? "Builders" : "Guests"}
                          key={device.id}
                        />
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5}>
                          <span className="muted-copy">No active devices yet. Invite or approve a device first.</span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <p className="panel-note">Next step: replace the manual Open WebUI user column with real account data when we connect its admin API or a supported configuration path.</p>
          </section>
        ) : null}

        {activeView === "onboarding" ? (
          <section id="onboarding" className="panel">
            <PanelHeader title="Onboarding" subtitle="Two clear paths: one for the server owner, one for the client device." />
            <div className="onboarding-split">
              <section className="onboarding-path" aria-labelledby="server-onboarding-title">
                <div className="path-heading">
                  <span className="flow-step">Server</span>
                  <div>
                    <h3 id="server-onboarding-title">Setup server</h3>
                    <p>Use this on the machine that runs ModelDock, Ollama, Tailscale and Open WebUI.</p>
                  </div>
                </div>
                <div className="onboarding-grid">
                  <OnboardingCard
                    step="1"
                    title="Install Ollama"
                    description="This is the local engine that downloads and runs your AI models."
                    ctaLabel="Download Ollama"
                    href="https://ollama.com/download"
                  />
                  <OnboardingCard
                    step="2"
                    title="Install and log in to Tailscale"
                    description="This puts the server inside your private network, without exposing public ports."
                    ctaLabel="Download Tailscale"
                    href="https://tailscale.com/download"
                  />
                  <OnboardingCard
                    step="3"
                    title="Connect Tailscale API"
                    description="Add the API key in the .env file so ModelDock can read devices and manage authorization."
                    ctaLabel="Open Settings"
                    href="#settings"
                  />
                  <OnboardingCard
                    step="4"
                    title="Connect Open WebUI"
                    description="Set the chat URL, then use Open WebUI for account login and the chat experience."
                    ctaLabel="Go to Usage"
                    href="#usage"
                  />
                </div>
              </section>

              <section className="onboarding-path" aria-labelledby="client-onboarding-title">
                <div className="path-heading">
                  <span className="flow-step">Client</span>
                  <div>
                    <h3 id="client-onboarding-title">Invite a client</h3>
                    <p>Use this for the phone, laptop or tablet that needs to reach the AI chat.</p>
                  </div>
                </div>
                <div className="onboarding-grid">
                  <OnboardingCard
                    step="1"
                    title="Send the download link"
                    description="The client installs Tailscale directly on their own device."
                    ctaLabel="Download Tailscale"
                    href="https://tailscale.com/download"
                  />
                  <OnboardingCard
                    step="2"
                    title="Client logs in"
                    description="They sign in with the account or invite you prepared for the server tailnet."
                    ctaLabel="Open login"
                    href="https://login.tailscale.com"
                  />
                  <OnboardingCard
                    step="3"
                    title="Approve and verify"
                    description="Refresh Devices in ModelDock and confirm the new device is visible, online and active."
                    ctaLabel="Go to Devices"
                    href="#devices"
                  />
                  <OnboardingCard
                    step="4"
                    title="Send the chat link"
                    description="Once the device is active, share the Open WebUI link and the account credentials you created there."
                    ctaLabel="Open chat"
                    href={displayChatUrl}
                  />
                </div>
              </section>
            </div>
            <div className="share-template">
              <div>
                <h3>Client message</h3>
                <p>Ready-to-send text for email, WhatsApp or Slack. Keep real passwords outside this message unless you choose another secure channel.</p>
              </div>
              <button className="secondary-button" type="button" onClick={() => void copyOnboardingText()}>
                {onboardingClipboard.copied ? "Copied" : "Copy text"}
              </button>
              <textarea aria-label="Onboarding message" readOnly value={onboardingShareText} />
            </div>
          </section>
        ) : null}

        {activeView === "settings" ? (
          <section id="settings" className="panel">
            <PanelHeader title="Settings" subtitle="Server identity, Open WebUI entry point and local interface preferences." />
            <div className="settings-sections">
              <section className="settings-card" aria-labelledby="server-identity-title">
                <div>
                  <span className="flow-step">Server identity</span>
                  <h3 id="server-identity-title">How this AI server appears</h3>
                  <p>Use a friendly name so onboarding messages and the dashboard title feel familiar.</p>
                </div>
                <label>
                  <span>Server name</span>
                  <input aria-label="Server name" value={settings.serverName} onChange={(event) => updateSettings({ serverName: event.target.value })} />
                </label>
              </section>

              <section className="settings-card" aria-labelledby="openwebui-settings-title">
                <div className="settings-card-heading">
                  <div>
                    <span className="flow-step">Open WebUI</span>
                    <h3 id="openwebui-settings-title">Chat URL and connection</h3>
                    <p>Set the URL people will open after their device is inside Tailscale. The backend health check still uses the `.env` URL.</p>
                  </div>
                  <span className={`device-status-pill ${openWebUIHealth?.status === "available" ? "online" : openWebUIHealth?.status === "not_configured" ? "unknown" : "offline"}`}>
                    {formatHealthStatus(openWebUIHealth?.status)}
                  </span>
                </div>
                <label>
                  <span>Chat URL</span>
                  <input
                    aria-label="Open WebUI chat URL"
                    placeholder="Example: http://100.x.y.z:3000 or your Tailscale MagicDNS URL"
                    value={settings.chatUrl}
                    onChange={(event) => updateSettings({ chatUrl: event.target.value })}
                  />
                </label>
                <div className="settings-actions">
                  <button className="secondary-button" type="button" onClick={() => void testOpenWebUIConnection()} disabled={system.isFetching}>
                    {system.isFetching ? "Testing…" : "Test connection"}
                  </button>
                  <a className="link-button" href={displayChatUrl} rel="noreferrer" target="_blank">
                    Open chat
                  </a>
                </div>
                <p className="settings-hint">{openWebUIHealth?.message ?? "Set MODELDOCK_OPENWEBUI_BASE_URL in .env for the backend health check."}</p>
              </section>

              <section className="settings-card" aria-labelledby="interface-settings-title">
                <div>
                  <span className="flow-step">Interface</span>
                  <h3 id="interface-settings-title">Local display preferences</h3>
                  <p>These options are saved only in this browser, not in the server configuration.</p>
                </div>
                <label>
                  <span>Theme</span>
                  <select aria-label="Theme" value={settings.theme} onChange={(event) => updateSettings({ theme: event.target.value as ThemePreference })}>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
              </section>
            </div>
            <p className="panel-note">Secrets stay in the .env file. Browser preferences stay here until we add shared server-side settings.</p>
          </section>
        ) : null}

        {activeView === "diagnostics" ? <section id="diagnostics" className="panel">
          <PanelHeader title="Diagnostics" subtitle="Checks are first-class, not an afterthought." />
          {runDiagnostics.data ? (
            <div className="diagnostic-list">
              {runDiagnostics.data.map((result) => (
                <DiagnosticResultRow key={result.id} result={result} />
              ))}
            </div>
          ) : (
            <div className="check-list">
              {(checks.data ?? []).map((check) => (
                <div className="check-row" key={check.id}>
                  <StatusDot on={true} label={`${check.label} ready`} />
                  <span>{check.label}</span>
                </div>
              ))}
            </div>
          )}
        </section> : null}

      </section>
    </main>
  );
}

function isModelUpdatePending(isPending: boolean, variables: UpdateModelAccessInput | undefined, modelName: string): boolean {
  return isPending && variables?.modelName === modelName;
}

function getModelRuntimeAction(isPending: boolean, variables: UpdateModelAccessInput | undefined, modelName: string): ModelRuntimeAction | null {
  if (!isModelUpdatePending(isPending, variables, modelName) || typeof variables?.loaded !== "boolean") {
    return null;
  }

  return variables.loaded ? "loading" : "unloading";
}
