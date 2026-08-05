#!/usr/bin/env bash
# Arranca o Sebinta e mostra o link de acesso assim que o túnel Cloudflare
# estiver pronto. Em modo Quick Tunnel (sem TUNNEL_TOKEN no .env) o domínio
# *.trycloudflare.com é atribuído aleatoriamente a cada arranque e só
# aparece nos logs do cloudflared — este script poupa-te a ires à procura.
set -euo pipefail
cd "$(dirname "$0")"

echo "A arrancar o Sebinta..."
docker compose up -d

if [ -n "${TUNNEL_TOKEN:-}" ] || grep -qE '^TUNNEL_TOKEN=.+' .env 2>/dev/null; then
  echo ""
  echo "Túnel nomeado configurado (TUNNEL_TOKEN definido) — acede ao domínio"
  echo "que escolheste no Cloudflare Zero Trust ao criar o túnel."
  exit 0
fi

echo "A aguardar que o túnel Cloudflare fique pronto…"
URL=""
for _ in $(seq 1 30); do
  URL=$(docker compose logs cloudflared 2>/dev/null | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done

echo ""
if [ -n "$URL" ]; then
  echo "Sebinta disponível em: $URL"
  echo "(muda a cada arranque em modo Quick Tunnel — corre ./start.sh outra vez para veres o novo link)"
else
  echo "Não consegui obter o link automaticamente. Vê os logs manualmente:"
  echo "  docker compose logs cloudflared"
fi
echo ""
