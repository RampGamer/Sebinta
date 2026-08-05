#!/usr/bin/env bash
# Descarrega os binários oficiais do cloudflared para as 4 plataformas
# suportadas, para dentro de standalone/assets/ — go:embed precisa deles
# presentes em disco no momento da compilação (ver tunnel_*.go). Corre isto
# uma vez antes de compilar; os binários não ficam no repositório (são
# grandes e mudam de versão para versão do cloudflared).
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${CLOUDFLARED_VERSION:-latest}"
BASE="https://github.com/cloudflare/cloudflared/releases"
if [ "$VERSION" = "latest" ]; then
  BASE="$BASE/latest/download"
else
  BASE="$BASE/download/$VERSION"
fi

mkdir -p assets
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "A descarregar cloudflared ($VERSION) para as 4 plataformas..."

curl -fsSL -o assets/cloudflared-linux-amd64 "$BASE/cloudflared-linux-amd64"
curl -fsSL -o assets/cloudflared-windows-amd64.exe "$BASE/cloudflared-windows-amd64.exe"

curl -fsSL -o "$tmp/darwin-amd64.tgz" "$BASE/cloudflared-darwin-amd64.tgz"
tar -xzf "$tmp/darwin-amd64.tgz" -C "$tmp"
mv "$tmp/cloudflared" assets/cloudflared-darwin-amd64

curl -fsSL -o "$tmp/darwin-arm64.tgz" "$BASE/cloudflared-darwin-arm64.tgz"
tar -xzf "$tmp/darwin-arm64.tgz" -C "$tmp"
mv "$tmp/cloudflared" assets/cloudflared-darwin-arm64

chmod +x assets/cloudflared-linux-amd64 assets/cloudflared-darwin-amd64 assets/cloudflared-darwin-arm64

echo "Pronto:"
ls -la assets/
