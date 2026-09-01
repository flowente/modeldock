#!/bin/bash
set -u

MODELDOCK_PNPM_VERSION="11.19.0"
MODELDOCK_TARGET="$HOME/Library/Application Support/ModelDock/app"
MODELDOCK_RUNTIME="$HOME/Library/Application Support/ModelDock/runtime/node"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
MODELDOCK_APP="$SCRIPT_DIR"

if [[ "${1:-}" == "--help" ]]; then
  echo "Avvia ModelDock dalla repository o lo scarica in:"
  echo "$MODELDOCK_TARGET"
  echo "Prepara un runtime locale, installa le dipendenze, crea .env, avvia i servizi e apre la welcome page."
  exit 0
fi

MODELDOCK_CHECK_ONLY="false"
if [[ "${1:-}" == "--check" ]]; then
  MODELDOCK_CHECK_ONLY="true"
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

MODELDOCK_NPX=""

if command -v node >/dev/null 2>&1 && [[ "$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)" -ge 24 ]]; then
  MODELDOCK_NPX="$(command -v npx)"
elif [[ -x "$MODELDOCK_RUNTIME/bin/node" ]] && [[ "$("$MODELDOCK_RUNTIME/bin/node" -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)" -ge 24 ]]; then
  export PATH="$MODELDOCK_RUNTIME/bin:$PATH"
  MODELDOCK_NPX="$MODELDOCK_RUNTIME/bin/npx"
else
  echo "[2/4] Preparazione del runtime locale..."
  download_dir="$(mktemp -d -t modeldock-node)"
  checksums="$download_dir/SHASUMS256.txt"
  machine_arch="$(uname -m)"

  if [[ "$machine_arch" == "arm64" ]]; then
    node_arch="arm64"
  else
    node_arch="x64"
  fi

  curl -fL "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" -o "$checksums"
  node_file="$(awk -v suffix="-darwin-$node_arch.tar.gz" 'index($2, suffix) == length($2) - length(suffix) + 1 { print $2; exit }' "$checksums")"

  if [[ -z "$node_file" ]]; then
    echo "Runtime Node.js compatibile non trovato."
    rm -rf "$download_dir"
    exit 1
  fi

  expected_hash="$(awk -v file="$node_file" '$2 == file { print $1; exit }' "$checksums")"
  curl -fL "https://nodejs.org/dist/latest-v24.x/$node_file" -o "$download_dir/$node_file"
  actual_hash="$(shasum -a 256 "$download_dir/$node_file" | awk '{print $1}')"

  if [[ "$actual_hash" != "$expected_hash" ]]; then
    echo "Verifica del runtime Node.js non riuscita."
    rm -rf "$download_dir"
    exit 1
  fi

  rm -rf "$MODELDOCK_RUNTIME"
  mkdir -p "$MODELDOCK_RUNTIME"
  tar -xzf "$download_dir/$node_file" -C "$MODELDOCK_RUNTIME" --strip-components=1
  rm -rf "$download_dir"
  export PATH="$MODELDOCK_RUNTIME/bin:$PATH"
  MODELDOCK_NPX="$MODELDOCK_RUNTIME/bin/npx"
fi

cd "$MODELDOCK_APP"

echo "[3/4] Installazione delle dipendenze di ModelDock..."
"$MODELDOCK_NPX" --yes "pnpm@$MODELDOCK_PNPM_VERSION" install --frozen-lockfile

if [[ ! -f ".env" ]]; then
  cp ".env.example" ".env"
fi

if [[ "$MODELDOCK_CHECK_ONLY" == "true" ]]; then
  echo "Launcher macOS verificato correttamente."
  exit 0
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

exec "$MODELDOCK_NPX" --yes "pnpm@$MODELDOCK_PNPM_VERSION" dev
