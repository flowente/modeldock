# ModelDock - MVP

## Goal

The MVP is successful when a user can run ModelDock on an AI server machine and understand, test and operate the core local LLM setup:

- models through Ollama;
- devices through Tailscale;
- chat entry through Open WebUI;
- onboarding for server and client devices;
- diagnostics without using the terminal.

## Included

- Home overview with Ollama, Devices and Open WebUI health.
- Real Ollama integration for installed models, pull, delete, load, unload and runtime refresh.
- Model access matrix with enabled, loaded and group permission intent.
- RAM-fit labels for installed models.
- Real Tailscale API integration for device inventory and authorization state.
- Devices page with overview, invite helper and safer confirmation before disabling a device.
- Usage page for Open WebUI link sharing and manual access mapping.
- Settings page for server name, Open WebUI chat URL and theme.
- Onboarding page split between server setup and client invitation.
- Diagnostics, structured health and test coverage.
- `.env.example`, server setup guide and public release checklist.

## Explicit MVP Boundaries

- ModelDock does not replace Open WebUI as the chat UI.
- Open WebUI account creation/sync is not automated yet.
- ModelDock settings are browser-local for now, except provider configuration in `.env`.
- Storage is still in-memory for this slice.
- Tailscale ACLs, tags, device removal and key expiry are post-MVP.
- GPU telemetry is post-MVP.

## Done Means

A feature is done only when it has:

- API or clearly scoped local UI state;
- understandable UI states for loading, empty, success and failure;
- useful logs, audit or health where relevant;
- tests around core behavior;
- documentation when setup or external credentials are involved.
