#!/bin/bash
# tagged: arranca a webapp neste Mac (duplo clique, ou ./start.command). Usa o chip da Apple, por isso é o modo mais rápido.
#   TAGGED_PORT=9000      porta (por defeito 8768)
#   TAGGED_NO_BROWSER=1   não abrir o browser (usado pelo arranque automático)
cd "$(dirname "$0")" || exit 1
PORT="${TAGGED_PORT:-8768}"
URL="http://127.0.0.1:$PORT"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

open_when_ready() {
  [ -n "$TAGGED_NO_BROWSER" ] && return 0
  for _ in $(seq 1 120); do
    curl -sf "$URL/api/ping" >/dev/null 2>&1 && { open "$URL"; return 0; }
    sleep 1
  done
}

if curl -sf "$URL/api/ping" >/dev/null 2>&1; then
  open_when_ready
  if [ -t 0 ]; then
    echo
    echo "  O tagged já está a correr em $URL (abri o browser)."
    echo "  Prime P para PARAR esse servidor, ou outra tecla para fechar esta janela (o servidor continua)."
    read -r -n 1 -s key
    case "$key" in p|P) pkill -f "tagged serve --port $PORT"; echo "  Servidor parado." ; sleep 1 ;; esac
  fi
  exit 0
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "O 'uv' (gestor de Python) não está instalado."
  read -r -p "Instalar agora a partir de https://astral.sh/uv ? [s/N] " ans
  case "$ans" in
    s|S|y|Y) curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH" ;;
    *) echo "Cancelado."; exit 1 ;;
  esac
fi
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Faltam as ferramentas de linha de comandos da Apple (o InsightFace compila uma extensão). Corre: xcode-select --install"
  exit 1
fi

cd backend || exit 1
echo "A preparar as dependências (a primeira vez demora uns minutos)..."
uv sync || { echo "O 'uv sync' falhou."; exit 1; }

open_when_ready &

# Run the installed command directly (no 'uv run' wrapper process), so stopping it is clean.
SERVER_BIN="./.venv/bin/tagged"
if [ ! -t 0 ]; then
  exec "$SERVER_BIN" serve --port "$PORT"          # started by the login agent: no terminal, no key to wait for
fi

"$SERVER_BIN" serve --port "$PORT" &
SERVER=$!
stop_server() { kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null; }
trap 'stop_server; exit 0' INT TERM HUP              # Ctrl+C or closing the window also stops it
clear
echo
echo "  ┌──────────────────────────────────────────────────────────┐"
echo "  │  tagged está a correr em $URL"
echo "  │"
echo "  │  Prime QUALQUER TECLA para parar o servidor."
echo "  │  (fechar esta janela também o pára)"
echo "  └──────────────────────────────────────────────────────────┘"
echo
while kill -0 "$SERVER" 2>/dev/null; do
  if read -r -n 1 -s -t 1 _; then
    stop_server
    echo "  Servidor parado. Podes fechar esta janela."
    sleep 1
    exit 0
  fi
done
echo "  O servidor parou inesperadamente (veja as mensagens acima). Prime uma tecla para fechar."
read -r -n 1 -s _
exit 1
