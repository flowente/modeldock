# ModelDock - Access Control

Version: 0.1

## Intent

ModelDock should manage local LLM access from one place, without pretending that every integration has the same permission model.

The product needs three layers:

- Network access: handled by Tailscale.
- Application access: handled by ModelDock.
- Workspace/provider access: handled by integrations such as Open WebUI.

ModelDock should become the source of truth for local LLM access, then apply or mirror that intent through adapters where each provider supports it.

## Users and Groups

ModelDock owns local users, groups and roles.

Initial roles:

- `admin`: can manage models, devices, access and settings.
- `operator`: can run diagnostics and non-destructive operations.
- `viewer`: can inspect status and audit.

Groups are the right abstraction for model access. Most permissions should be granted to groups first, then users can be added to those groups.

## Model Access

A model has three separate states:

- `installed`: the model exists in Ollama.
- `enabled`: ModelDock allows users to use it.
- `loaded`: the runtime currently keeps the model warm in memory.

These states should not be collapsed into one toggle.

Recommended controls:

- enable or disable model use;
- warm or eject the model from runtime memory;
- grant access to users or groups;
- probe model;
- delete model with confirmation and audit.

## Device Access

Tailscale decides whether a device can join the private network. ModelDock decides what a signed-in user can do once they reach ModelDock.

The Network page should start as read-only. Device administration can become the last MVP extension only after:

- a Tailscale API token is configured server-side;
- mutating actions are audited;
- destructive actions have confirmation;
- diagnostics can prove the Tailscale API integration is healthy;
- failures are shown clearly in the UI.

Planned device actions:

- authorize device;
- deauthorize device;
- expire device key;
- set device tags;
- remove device.

Tailscale ACL/policy editing should stay post-MVP because a bad policy write can lock users out or weaken the tailnet.

## Open WebUI Access

Open WebUI already has RBAC, groups and per-resource access. ModelDock should not blindly duplicate those screens.

There are three possible integration levels:

1. Link-only.
   ModelDock stores the Open WebUI URL and exposes a working link. Access remains managed in Open WebUI.

2. Guarded access.
   ModelDock controls who can open the Open WebUI link or proxy entrypoint. This is useful, but it does not replace Open WebUI internal permissions.

3. Managed sync.
   ModelDock becomes the source of truth and syncs users, groups and model access into Open WebUI through a dedicated adapter.

The recommended MVP path is link-only first, guarded access second, managed sync last.

## Access Matrix

The central UI should become an access matrix:

```text
Model        Enabled   Loaded   Admins   Operators   Guests
llama3.1:8b  yes       yes      use      use         no
phi3:mini    yes       no       use      use         use
deepseek     no        no       use      no          no
```

This makes ModelDock different from a generic chat UI: it shows operational state and access state together.

## Server Links

The sidebar should show the current ModelDock server URL with a copy button. Later, the same area can expose configured links:

- ModelDock server URL;
- Open WebUI URL;
- Tailscale admin console URL;
- public or tailnet-only reachability status.

The URL shown in the browser should default to `window.location.origin`, because that is the address the current user actually used to reach ModelDock.

## API Sketch

```http
GET /api/access/users
GET /api/access/groups
GET /api/access/models
PUT /api/access/models/:modelName

GET /api/integrations/openwebui/status
GET /api/integrations/openwebui/link
POST /api/integrations/openwebui/sync

GET /api/network/tailscale/admin/status
POST /api/network/tailscale/devices/:deviceId/authorize
POST /api/network/tailscale/devices/:deviceId/deauthorize
POST /api/network/tailscale/devices/:deviceId/expire-key
POST /api/network/tailscale/devices/:deviceId/tags
DELETE /api/network/tailscale/devices/:deviceId
```

## Definition of Done

Access control work is done only when:

- ModelDock has one clear source of truth;
- mutating operations are audited;
- permissions are tested;
- diagnostics cover configured providers;
- UI distinguishes ModelDock permissions from Tailscale and Open WebUI provider permissions;
- secrets never reach the frontend.

