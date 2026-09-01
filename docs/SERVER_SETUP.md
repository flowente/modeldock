# ModelDock - Server Setup

This guide is for the computer that will act as the AI server.

## What the server runs

- Ollama for local model inference.
- Tailscale for private remote access.
- Open WebUI for the chat experience.
- ModelDock as the control dashboard.

## 1. Install prerequisites

- Node.js 24 or newer.
- pnpm 11.
- Internet access during the first setup.

Ollama and Open WebUI are detected, installed when supported and started by ModelDock. Tailscale authentication remains in the official Tailscale application so the user can choose Google, GitHub or another configured identity provider.

## 2. Configure ModelDock

Copy the example environment file:

```powershell
Copy-Item .env.example .env
```

Then edit `.env`.

The default local configuration is enough for onboarding:

```env
MODELDOCK_OLLAMA_MODE=auto
MODELDOCK_OLLAMA_BASE_URL=http://127.0.0.1:11434

MODELDOCK_TAILSCALE_MODE=auto
MODELDOCK_TAILSCALE_TAILNET=-
MODELDOCK_TAILSCALE_API_TOKEN=

MODELDOCK_OPENWEBUI_BASE_URL=
```

Do not put real tokens in chat, screenshots, commits or issues.

## 3. Start ModelDock

```powershell
pnpm install
pnpm dev
```

Open:

```text
http://127.0.0.1:5173
```

The welcome flow then:

1. verifies the private Tailscale connection without asking for Tailscale credentials;
2. detects or prepares Ollama;
3. prepares and starts a managed Open WebUI instance;
4. creates the first local chat administrator;
5. detects the private server URL and prepares the client invitation.

The Open WebUI administrator password is used only during account creation and is not stored by ModelDock.

For a production-like preview:

```powershell
pnpm build
pnpm --filter @modeldock/api dev
pnpm --filter @modeldock/web preview
```

Open:

```text
http://127.0.0.1:4173
```

## 4. Verify the MVP

- Home shows Ollama, Devices and Open WebUI status.
- Models lists the models installed in Ollama.
- Models can pull, delete, load, unload and refresh runtime state.
- Devices lists Tailscale devices.
- Usage shows the Open WebUI chat link and access map.
- Setup guidato separates private-network access, local chat administration and client invitation.
- Diagnostics can run checks without using the terminal.

## 5. Invite a client device

Use the Onboarding page or Devices page to copy the invite message.

The client device must:

1. Install Tailscale.
2. Log in or accept the tailnet invite.
3. Wait for approval if required.
4. Open the Open WebUI chat URL.

ModelDock should then show the device in Devices after refresh.
