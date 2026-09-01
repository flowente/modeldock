# ModelDock

ModelDock is an open-source control dashboard for a local AI server.

It brings together:

- Ollama models;
- Tailscale devices;
- Open WebUI access;
- onboarding for server owners and client devices;
- diagnostics and testable integration checks.

The goal is simple: manage a private local LLM setup from one web dashboard, without jumping between terminals, scattered config files and provider consoles.

## Current MVP

ModelDock currently includes:

- Home overview with Ollama, Devices and Open WebUI status;
- Models page backed by Ollama:
  - installed model inventory;
  - pull model with progress and failure feedback;
  - delete model;
  - load/unload model through Ollama runtime APIs;
  - runtime refresh for models loaded outside ModelDock;
  - RAM-fit labels;
  - simple group access matrix;
- Devices page backed by Tailscale:
  - visible devices;
  - online/offline state;
  - active/authorized state;
  - invite-new-device helper;
  - confirmation before disabling a device;
- Usage page for Open WebUI:
  - shareable chat URL;
  - Open WebUI health status;
  - manual MVP access map between devices, Open WebUI users and model groups;
- Onboarding page:
  - server setup path;
  - client invitation path;
  - copyable client message;
- Settings page:
  - server display name;
  - Open WebUI chat URL;
  - light/dark theme;
- Diagnostics and tests around core behavior.
- Full-screen guided first-run setup:
  - detects and starts Ollama, installing it when supported and missing;
  - prepares and starts a managed Open WebUI instance;
  - creates the first local chat administrator without storing the password;
  - verifies the local Tailscale connection and detects the private server URL;
  - prepares a client invitation message.

## What ModelDock is not yet

ModelDock does not yet replace Open WebUI as a chat interface.

For now, Open WebUI remains the chat surface. ModelDock is the control surface around it: models, devices, access intent, setup and diagnostics.

Post-MVP work can add:

- broader Open WebUI account and permission synchronization;
- persistent ModelDock users;
- durable database storage;
- Tailscale ACL/tag management;
- GPU telemetry;
- a packaged desktop/server installer that removes the Node.js prerequisite.

## Requirements

- Windows 10/11 or macOS for the current guided installer path.
- Internet access during the first setup.

The double-click launchers include a verified portable Node.js runtime when the computer does not already have a compatible version. They do not install Node.js system-wide. Manual installation requires Node.js 24 or newer; pnpm is executed at the version pinned by this repository.

Ollama and Open WebUI do not need to be installed beforehand: the guided setup detects existing installations and prepares what is missing. Tailscale is installed or opened through its official application because its device login can use Google, GitHub or another identity provider.

## Quick start

### Double-click launcher

For the simplest first test:

- Windows: download and double-click [`start-modeldock.bat`](start-modeldock.bat).
- macOS: download [`start-modeldock.command`](start-modeldock.command), allow execution once with `chmod +x start-modeldock.command`, then double-click it.

The launcher can be used inside the cloned repository or downloaded on its own. When downloaded alone it retrieves the current `main` branch into the operating system's local application-data folder. It then:

1. uses a compatible system Node.js or downloads a verified portable runtime inside ModelDock;
2. updates ModelDock when the launcher was downloaded on its own and installs the pinned project dependencies;
3. creates the local `.env` file if missing;
4. creates a stable production build and starts both the ModelDock API and interface;
5. waits until both services respond, then opens `http://127.0.0.1:4173/#welcome` automatically.

Keep the launcher window open while using ModelDock. Closing it stops the local application. These launchers are the MVP distribution path; a later signed desktop package will remove the visible terminal and remaining operating-system warnings.

### Manual installation

1. Clone or download this repository:

```text
git clone https://github.com/flowente/modeldock.git
cd modeldock
```

2. Open a terminal in the `modeldock` folder.
3. Enable pnpm and install the project:

```text
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install
```

4. Create the local environment file.

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS:

```bash
cp .env.example .env
```

5. Start ModelDock:

```text
pnpm dev
```

Open:

```text
http://127.0.0.1:5173
```

The API defaults to:

```text
http://127.0.0.1:4317
```

## Environment

ModelDock reads configuration from `.env`.

Start from:

```text
.env.example
```

The defaults are sufficient for the guided local setup. Advanced keys include:

- `MODELDOCK_OLLAMA_MODE`
- `MODELDOCK_OLLAMA_BASE_URL`
- `MODELDOCK_TAILSCALE_MODE`
- `MODELDOCK_TAILSCALE_API_TOKEN` (optional, for remote device administration)
- `MODELDOCK_TAILSCALE_TAILNET`
- `MODELDOCK_OPENWEBUI_BASE_URL`

Never commit real tokens or auth keys.

## Running against real local services

Typical local server setup:

```env
MODELDOCK_OLLAMA_MODE=auto
MODELDOCK_OLLAMA_BASE_URL=http://127.0.0.1:11434

MODELDOCK_TAILSCALE_MODE=auto
MODELDOCK_TAILSCALE_TAILNET=-
MODELDOCK_TAILSCALE_API_TOKEN=

MODELDOCK_OPENWEBUI_BASE_URL=
```

Then run:

```powershell
pnpm dev
```

Open `http://127.0.0.1:5173/#welcome` and follow the guided setup. ModelDock stores generated local integration values in `.env`; passwords are not persisted.

See [Server Setup](docs/SERVER_SETUP.md) for the full server/client workflow.

## Commands

```powershell
pnpm test
pnpm lint
pnpm build
pnpm test:e2e
```

`pnpm lint` currently runs TypeScript typechecks across the workspace.

## Architecture

ModelDock is a modular TypeScript monolith:

```text
apps/
  api/       Fastify backend
  web/       React/Vite dashboard
packages/
  auth/
  core/
  diagnostics/
  observability/
  ollama-adapter/
  storage/
  tailscale-adapter/
  testing/
```

The UI never talks directly to Ollama, Tailscale or Open WebUI. The backend owns adapters, validation, diagnostics and error handling.

See [Architecture](docs/ARCHITECTURE.md).

## Project handoff

If you are resuming the project from another chat or session, start from [Project Handoff](docs/HANDOFF.md).

## Before publishing

Read [Public Release Checklist](docs/PUBLIC_RELEASE_CHECKLIST.md).
