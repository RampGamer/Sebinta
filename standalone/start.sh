#!/usr/bin/env bash
# Arranca o servidor standalone (binário Go, sem Docker) e, se tiveres o
# cloudflared instalado, liga também um túnel Quick Tunnel e imprime o link
# assim que ficar pronto — sem isto, o URL só aparece perdido nos logs do
# cloudflared.
set -uo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
LOG_DIR="$(mktemp -d)"
SERVER_LOG="$LOG_DIR/server.log"
TUNNEL_LOG="$LOG_DIR/cloudflared.log"

# --- escolher o binário para este SO/arquitetura ---
BINARY="${FILEPAD_SERVER_BIN:-}"
if [ -z "$BINARY" ]; then
  if [ -x "./filepad-server" ]; then
    BINARY="./filepad-server"
  else
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64)   BINARY="./dist/filepad-server-linux-amd64" ;;
      Darwin-arm64)   BINARY="./dist/filepad-server-macos-arm64" ;;
      Darwin-x86_64)  BINARY="./dist/filepad-server-macos-amd64" ;;
      *) echo "Não sei qual binário usar para $(uname -s)-$(uname -m)." \
              "Define FILEPAD_SERVER_BIN=/caminho/para/o/binario e tenta outra vez." >&2
         exit 1 ;;
    esac
  fi
fi
if [ ! -x "$BINARY" ]; then
  echo "Binário não encontrado ou não executável: $BINARY" >&2
  echo "Compila primeiro (ver README) ou define FILEPAD_SERVER_BIN." >&2
  exit 1
fi

echo "A arrancar $BINARY na porta $PORT…"
PORT="$PORT" "$BINARY" > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "O servidor não arrancou — ver log:" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi
echo "Servidor a correr localmente em http://localhost:$PORT"

CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
if ! command -v "$CLOUDFLARED_BIN" >/dev/null 2>&1; then
  echo ""
  echo "cloudflared não encontrado — o servidor fica só acessível localmente."
  echo "Instala o cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)"
  echo "e corre este script outra vez para teres um link público automaticamente."
  wait "$SERVER_PID"
  exit 0
fi

echo "A ligar o túnel Cloudflare…"
"$CLOUDFLARED_BIN" tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1)
  [ -n "$URL" ] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "O cloudflared terminou antes de estabelecer o túnel — ver log:" >&2
    cat "$TUNNEL_LOG" >&2
    break
  fi
  sleep 1
done

echo ""
if [ -n "$URL" ]; then
  echo "Filepad disponível em: $URL"
  echo "(muda a cada arranque — corre este script outra vez para veres o novo link)"
else
  echo "Não consegui obter o link automaticamente. Log do cloudflared:"
  cat "$TUNNEL_LOG" >&2
fi
echo ""
echo "Ctrl+C para parar tudo."

wait "$SERVER_PID"
