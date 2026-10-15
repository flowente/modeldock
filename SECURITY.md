# Security Policy

ModelDock runs a private AI server and keeps accounts, conversations and permissions on the
server computer.

## What is protected, and how

- **The API** listens on `127.0.0.1` only. Other devices reach it through the device
  connection (`packages/link`, port 4319), over TLS.
- **First run**: the first administrator can only be created from the server computer.
- **Passwords** are stored as scrypt hashes. Session and invitation tokens are stored as SHA-256
  hashes only. Sessions are HttpOnly, SameSite=Strict cookies.
- **Login** is rate-limited per address.
- **Model permissions** are enforced on the server, not only hidden in the interface.
- **Devices** joined with ModelDock Link check the server's certificate fingerprint before
  sending anything, and must be approved by an administrator.
- **Browsers without the client** (`MODELDOCK_LINK_ALLOW_BROWSERS`) see a certificate warning
  the first time and are protected only by the login. Turn it off to accept only joined devices.

## Secrets

Never commit `.env`, the `data/` folder (database, server key and certificate), passwords or
invitation links.

## Reporting issues

Open a private issue or contact the maintainer directly if the report includes secrets,
private network details or exploitable vulnerabilities.
