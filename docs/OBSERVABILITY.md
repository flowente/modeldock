# ModelDock - Observability

Observability is part of the product. ModelDock must explain failures clearly because it sits between the user, Ollama, Tailscale, and local storage.

## Signals

- structured logs;
- audit events;
- health status;
- diagnostic checks.

## Correlation

Every API request should have a correlation id. The same id should appear in logs, audit events, and error responses.

## Diagnostic Result

```json
{
  "id": "ollama.connection",
  "status": "pass",
  "message": "Ollama is reachable",
  "durationMs": 35,
  "suggestion": null
}
```

## Privacy

Never log tokens, cookies, passwords, authorization headers, or full prompts by default.

