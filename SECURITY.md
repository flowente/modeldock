# Security Policy

ModelDock controls local AI infrastructure and can interact with external services such as Tailscale, Ollama and Open WebUI.

## Secrets

Never commit:

- `.env`;
- Tailscale API tokens;
- Tailscale auth keys;
- Open WebUI admin tokens;
- passwords;
- private device inventories.

Use `.env.example` for documentation and `.env` for local secrets.

## Tailscale device actions

Device authorization changes are real external actions. Disabling a device can remove its access to the private network.

ModelDock should keep confirmations, audit events and clear failure messages around these operations.

## Open WebUI

The MVP treats Open WebUI as a linked chat surface with health checks. Account synchronization is not automated yet.

Do not store Open WebUI passwords in ModelDock until a dedicated secure credential flow exists.

## Reporting issues

For now, open a private issue or contact the maintainer directly if the report includes secrets, private network details or exploitable vulnerabilities.
