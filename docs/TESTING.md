# ModelDock - Testing

Testing starts with the architecture, not after it.

## Layers

- unit tests for core behavior and permissions;
- integration tests for API, adapter contracts, storage, and audit;
- fake gateways for stable development;
- Playwright smoke tests when the UI flows mature.

## Fake Scenarios

- all dependencies available;
- Ollama offline;
- Tailscale offline;
- empty model list;
- partial Tailscale device data;
- failed model pull;
- failed model delete.

## First Tests

- health aggregation;
- viewer cannot delete models;
- diagnostics return pass/warn/fail;
- API returns system status;
- audit store persists events in order.

