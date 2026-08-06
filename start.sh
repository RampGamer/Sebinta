#!/usr/bin/env bash
# Starts Sebinta and shows the access link as soon as the Cloudflare tunnel
# is ready. In Quick Tunnel mode (no TUNNEL_TOKEN in .env) the
# *.trycloudflare.com domain is assigned randomly on every startup and only
# shows up in the cloudflared logs — this script saves you from digging for it.
set -euo pipefail
cd "$(dirname "$0")"

echo "Starting Sebinta..."
docker compose up -d

if [ -n "${TUNNEL_TOKEN:-}" ] || grep -qE '^TUNNEL_TOKEN=.+' .env 2>/dev/null; then
  echo ""
  echo "Named tunnel configured (TUNNEL_TOKEN set) — access the domain"
  echo "you chose in Cloudflare Zero Trust when you created the tunnel."
  exit 0
fi

echo "Waiting for the Cloudflare tunnel to be ready…"
URL=""
for _ in $(seq 1 30); do
  URL=$(docker compose logs cloudflared 2>/dev/null | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done

echo ""
if [ -n "$URL" ]; then
  echo "Sebinta available at: $URL"
  echo "(changes on every startup in Quick Tunnel mode — run ./start.sh again to see the new link)"
else
  echo "Could not get the link automatically. Check the logs manually:"
  echo "  docker compose logs cloudflared"
fi
echo ""
