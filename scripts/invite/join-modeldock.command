#!/bin/bash
# ModelDock client join (macOS)
# Installs Tailscale (via Homebrew if available) if missing and joins the
# ModelDock server's private network using a one-time auth key.
#
# The auth key is a credential. It is single-use and short-lived: do not share it.
#
# Usage (the server owner fills in the values before sending this to the client):
#   AUTH_KEY="tskey-auth-..." CHAT_URL="https://server.taildomain.ts.net" ./join-modeldock.command

set -euo pipefail

AUTH_KEY="${AUTH_KEY:-${1:-}}"
CHAT_URL="${CHAT_URL:-${2:-}}"
HOSTNAME_ARG="${HOSTNAME_ARG:-$(hostname -s)}"

if [ -z "${AUTH_KEY}" ]; then
  echo "Missing auth key. Set AUTH_KEY or pass it as the first argument." >&2
  exit 1
fi

echo "ModelDock - joining your team's private AI network..."

if ! command -v tailscale >/dev/null 2>&1 && [ ! -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "Tailscale is not installed. Installing via Homebrew..."
    brew install --cask tailscale
  else
    echo "Tailscale is not installed."
    echo "Please install it from https://tailscale.com/download/mac, open it once, then re-run this script."
    open "https://tailscale.com/download/mac"
    exit 1
  fi
fi

TS_CLI="tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  TS_CLI="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi

echo "Connecting this device to the network..."
sudo "${TS_CLI}" up --authkey "${AUTH_KEY}" --hostname "${HOSTNAME_ARG}" --accept-routes

echo ""
echo "Done. This device is now on your team's private network."
if [ -n "${CHAT_URL}" ]; then
  echo "Opening the chat: ${CHAT_URL}"
  open "${CHAT_URL}"
else
  echo "Ask the server owner for the chat address to start using ModelDock."
fi
