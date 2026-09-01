#!/bin/bash
set -u

MODELDOCK_PNPM_VERSION="11.19.0"
MODELDOCK_TARGET="$HOME/Library/Application Support/ModelDock/app"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
MODELDOCK_APP="$SCRIPT_DIR"

if [[ "${1:-}" == "--help" ]]; then
  echo "Avvia ModelDock dalla repository o lo scarica in:"
  echo "$MODELDOCK_TARGET"
  echo "Installa le dipendenze, crea .env, avvia i servizi e apre la welcome page."
  exit 0
fi

echo
echo " ModelDock"
echo " Preparazione del server AI locale..."
echo

if [[ ! -f "$MODELDOCK_APP/package.json" ]]; then
  MODELDOCK_APP="$MODELDOCK_TARGET"

  if [[ ! -f "$MODELDOCK_APP/package.json" ]]; then
    echo "[1/4] Download di ModelDock..."
    download_dir="$(mktemp -d -t modeldock)"
    archive="$download_dir/modeldock.zip"

    if ! curl -fL "https://github.com/flowente/modeldock/archive/refs/heads/main.zip" -o "$archive"; then
      echo "Il download di ModelDock non è riuscito."
      rm -rf "$download_dir"
      exit 1
    fi

    mkdir -p "$MODELDOCK_APP"
    ditto -x -k "$archive" "$download_dir"
    cp -R "$download_dir/modeldock-main/." "$MODELDOCK_APP/"
    rm -rf "$download_dir"
  fi
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)" -lt 24 ]]; then
  if command -v brew >/dev/null 2>&1; then
    echo "[2/4] Installazione di Node.js..."
    brew install node@24
    export PATH="$(brew --prefix node@24)/bin:$PATH"
  else
    echo "Node.js 24 o successivo è necessario."
    open "https://nodejs.org/en/download"
    echo "Installa Node.js, poi avvia di nuovo questo file."
    read -r -p "Premi Invio per chiudere."
    exit 1
  fi
fi

cd "$MODELDOCK_APP"

echo "[3/4] Installazione delle dipendenze di ModelDock..."
npx --yes "pnpm@$MODELDOCK_PNPM_VERSION" install --frozen-lockfile

if [[ ! -f ".env" ]]; then
  cp ".env.example" ".env"
fi

echo "[4/4] Avvio di ModelDock..."
echo "La pagina di benvenuto si aprirà automaticamente."
echo "Chiudi questa finestra per arrestare ModelDock."
echo

(
  for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:5173/" >/dev/null 2>&1; then
      open "http://127.0.0.1:5173/#welcome"
      exit 0
    fi
    sleep 1
  done
) &

exec npx --yes "pnpm@$MODELDOCK_PNPM_VERSION" dev
