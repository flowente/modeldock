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

## What ModelDock is not yet

ModelDock does not yet replace Open WebUI as a chat interface.

For now, Open WebUI remains the chat surface. ModelDock is the control surface around it: models, devices, access intent, setup and diagnostics.

Post-MVP work can add:

- Open WebUI account synchronization;
- persistent ModelDock users;
- durable database storage;
- Tailscale ACL/tag management;
- GPU telemetry;
- packaged desktop/server installer.

## Requirements

- Node.js 24 or newer.
- pnpm 11.
- Ollama for real model management.
- Tailscale for real device management.
- Open WebUI if you want the chat link and health check to be active.

## Quick start

```powershell
pnpm install
Copy-Item .env.example .env
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

Important keys:

- `MODELDOCK_OLLAMA_MODE`
- `MODELDOCK_OLLAMA_BASE_URL`
- `MODELDOCK_TAILSCALE_MODE`
- `MODELDOCK_TAILSCALE_API_TOKEN`
- `MODELDOCK_TAILSCALE_TAILNET`
- `MODELDOCK_OPENWEBUI_BASE_URL`

Never commit real tokens or auth keys.

## Running against real local services

Typical local server setup:

```env
MODELDOCK_OLLAMA_MODE=auto
MODELDOCK_OLLAMA_BASE_URL=http://127.0.0.1:11434

MODELDOCK_TAILSCALE_MODE=api
MODELDOCK_TAILSCALE_TAILNET=-
MODELDOCK_TAILSCALE_API_TOKEN=your_tailscale_api_token

MODELDOCK_OPENWEBUI_BASE_URL=http://127.0.0.1:3000
```

Then run:

```powershell
pnpm dev
```

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

## Before publishing

Read [Public Release Checklist](docs/PUBLIC_RELEASE_CHECKLIST.md).
