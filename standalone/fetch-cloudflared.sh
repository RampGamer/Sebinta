#!/usr/bin/env bash
# Downloads the official cloudflared binaries for the 4 supported
# platforms, into standalone/assets/ — go:embed needs them present on disk
# at build time (see tunnel_*.go). Run this once before building; the
# binaries don't live in the repo (they're large and change from version to
# version of cloudflared).
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

echo "Downloading cloudflared ($VERSION) for the 4 platforms..."

curl -fsSL -o assets/cloudflared-linux-amd64 "$BASE/cloudflared-linux-amd64"
curl -fsSL -o assets/cloudflared-windows-amd64.exe "$BASE/cloudflared-windows-amd64.exe"

curl -fsSL -o "$tmp/darwin-amd64.tgz" "$BASE/cloudflared-darwin-amd64.tgz"
tar -xzf "$tmp/darwin-amd64.tgz" -C "$tmp"
mv "$tmp/cloudflared" assets/cloudflared-darwin-amd64

curl -fsSL -o "$tmp/darwin-arm64.tgz" "$BASE/cloudflared-darwin-arm64.tgz"
tar -xzf "$tmp/darwin-arm64.tgz" -C "$tmp"
mv "$tmp/cloudflared" assets/cloudflared-darwin-arm64

chmod +x assets/cloudflared-linux-amd64 assets/cloudflared-darwin-amd64 assets/cloudflared-darwin-arm64

echo "Done:"
ls -la assets/
