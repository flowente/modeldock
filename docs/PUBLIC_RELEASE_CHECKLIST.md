# ModelDock - Public Release Checklist

Use this before creating the public GitHub repository.

## Secrets

- `.env` is ignored.
- Real Tailscale API tokens are not committed.
- Local notes containing API keys are ignored or removed.
- Screenshots do not show tokens, auth keys or private device details.

## Product readiness

- README explains the current MVP.
- `.env.example` lists all supported configuration keys.
- Server setup guide works from a fresh machine.
- Open WebUI is documented as link/health-check MVP, not full account sync.
- Tailscale device authorization is clearly marked as a real external action.

## Verification

Run:

```powershell
pnpm test
pnpm lint
pnpm build
pnpm test:e2e
```

On Windows, Playwright may need permission to launch Chromium.

## Repository

- Choose final public repo name.
- Add license.
- Add screenshots after removing private hostnames or device names.
- Create GitHub repo.
- Push first commit.

Recommended first public description:

> ModelDock is an open-source control dashboard for a local AI server: Ollama models, Tailscale devices, Open WebUI access and onboarding from one place.
