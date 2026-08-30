# ModelDock - Architecture

ModelDock starts as a modular monolith: one simple deployable app, with internal modules that keep the product maintainable.

## Runtime

```text
Browser
  |
  v
ModelDock Web UI
  |
  v
ModelDock Backend API
  |
  +--> Auth / permissions
  +--> Core domain
  +--> Observability
  +--> Diagnostics
  +--> Resource metrics
  +--> Storage
  |
  +--> Ollama adapter ----> Ollama local API
  |
  +--> Tailscale adapter -> Tailscale CLI or Tailscale HTTP API
  |
  +--> Open WebUI health -> Open WebUI HTTP endpoint
```

## Rules

1. The UI never talks directly to Ollama or Tailscale.
2. The backend mediates validation, authorization, audit, and error handling.
3. External dependencies live behind adapters.
4. The core owns contracts and use cases, not transport details.
5. Every feature must be observable and testable.

## Repository Shape

```text
apps/
  api/
  web/
packages/
  auth/                 roles and operation permissions
  core/                 domain contracts and model access matrix
  diagnostics/
  observability/
  ollama-adapter/
  storage/
  tailscale-adapter/
  testing/
```

## Frontend Shape

The web app keeps `App.tsx` as the orchestration layer only: data queries, mutations, route selection and page composition. Reusable UI language lives in `apps/web/src/components`, browser-local behavior lives in `apps/web/src/hooks`, and formatting/derived view logic lives in `apps/web/src/lib`.

This keeps the interface easier to evolve: new pages should compose existing small pieces instead of adding unrelated logic to `App.tsx`.

## MVP Dependency Strategy

The API supports fake gateways for deterministic tests and real adapters for local use.

- Ollama can run in `fake`, `real` or `auto` mode.
- Tailscale can run in `fake`, `cli`, `api` or `auto` mode.
- Open WebUI is currently a health check and shareable link integration.

Real provider credentials stay server-side in `.env`.

## Resource Metrics

The backend can expose CPU and RAM metrics directly from the host runtime. GPU metrics should stay behind provider-specific adapters because Windows, NVIDIA, AMD, ROCm and Apple hardware expose telemetry differently.

## Access Direction

Access management belongs inside ModelDock, but provider-specific enforcement must stay behind adapters.

- ModelDock owns users, groups, roles and the model access matrix.
- Tailscale owns network membership and device authorization.
- Open WebUI owns its internal workspace permissions unless ModelDock is explicitly configured to sync them.

See `docs/ACCESS_CONTROL.md` for the planned access model.
