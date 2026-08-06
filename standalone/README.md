# sebinta-server (standalone)

A Go port of the Sebinta server (`server/`, Node/Express), for anyone who
wants to run it **without Docker** and without installing anything: a
single static binary, no runtime to install, no `npm install`, no C
toolchain (the SQLite driver used, `modernc.org/sqlite`, is pure Go) — and
with **`cloudflared` itself embedded**, so you don't have to install that
separately either. Download one file, run it, and your pad is already
publicly reachable.

Functional parity with the Node server **as it stands today** (no
metadata cleaning — see `desktop/` or `cli/` for that): same routes, same
cookie/CSRF model, same WebSocket protocol, same frontend (`public/`,
embedded in the binary via `go:embed` — no extra files needed next to the
executable).

**Both servers share the same SQLite schema** — you can point
`DATA_DIR`/`UPLOADS_DIR` at the same folder the Docker version uses and
read the same pads/files with no migration (just don't run both at the
same time against the same folder).

## Run a prebuilt binary

Download the binary for your platform from
[Releases](https://github.com/RampGamer/Sebinta/releases) — the filename
includes the version, e.g. `sebinta-server-v1.7.0-linux-amd64`.

On Linux and macOS, make it executable first — downloads don't keep that
bit, and without it the binary just fails silently (`permission denied`,
no window, nothing) when you try to run it:

```bash
chmod +x sebinta-server-v1.7.0-linux-amd64
./sebinta-server-v1.7.0-linux-amd64
```

On Windows, just double-click the `.exe` (or run it from a terminal —
`.exe` files don't need this step).

That's the whole setup: it starts the server on port 3000, automatically
opens a Cloudflare Quick Tunnel (using the `cloudflared` embedded in the
binary — nothing to install), and **prints the link as soon as it's
ready**:

```
Sebinta available at: https://random-words-here.trycloudflare.com
```

That link changes on every startup (that's how Quick Tunnel works — no
Cloudflare account, no fixed domain). For a fixed domain, set
`TUNNEL_TOKEN` (the same named-tunnel token documented in the root
README — this binary reads it automatically, same as the Docker Compose
`cloudflared` service). To run local-only, with no tunnel at all:

```bash
DISABLE_TUNNEL=true ./sebinta-server-linux-amd64
```

Configure the rest with the same environment variables as the Docker
version (the root project's `.env` works fine — this binary reads a
`.env` file in the folder it runs from, if one exists):

```bash
SITE_PASSWORD=apassword COOKIE_SECRET=$(openssl rand -hex 32) ./sebinta-server-linux-amd64
```

Logs (including `cloudflared`'s own output) are also persisted to
`DATA_DIR/sebinta.log` (configurable with `LOG_FILE`), so you can run the
binary in the background without losing the history.

## Build from source

Requires Go 1.22+ (uses `net/http.ServeMux` patterns introduced in that
version).

`go:embed` needs the `cloudflared` binaries present on disk at build time
(one per platform — see "How cloudflared gets embedded" below) — fetch
them first:

```bash
cd standalone
./fetch-cloudflared.sh   # downloads into assets/ (not checked in — ~40-55MB each)
go build -o sebinta-server .
```

### Cross-compile for all 4 platforms

```bash
CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -o dist/sebinta-server-linux-amd64     .
CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -o dist/sebinta-server-macos-arm64     .
CGO_ENABLED=0 GOOS=darwin  GOARCH=amd64 go build -o dist/sebinta-server-macos-amd64     .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o dist/sebinta-server-windows-amd64.exe .
```

`CGO_ENABLED=0` works for all of them because the SQLite driver
(`modernc.org/sqlite`) is pure Go — without that, cross-compiling from a
single machine wouldn't be possible without a C toolchain per platform.
`fetch-cloudflared.sh` downloads all 4 binaries at once
(`assets/cloudflared-linux-amd64`, `-darwin-amd64`, `-darwin-arm64`,
`-windows-amd64.exe`); each `go build` above only embeds the one matching
its own `GOOS`/`GOARCH` (see `tunnel_<os>_<arch>.go` — one file per
platform, whose filename alone determines which build it applies to, no
`//go:build` needed).

### How cloudflared gets embedded

There's no way to import `cloudflared` as a Go library — its entry point
is `package main` (Go itself refuses to import that from another module),
and the internal packages that do the real work (`supervisor`,
`orchestration`, ...) aren't a public API meant for external reuse. The
realistic option, and the one this project uses, is to embed the
**official binary** via `go:embed` and run the exact same process you'd
run manually — just without having to install it yourself.

### If you change the frontend (`public/`)

This project embeds a **copy** of `../public/` (`standalone/public/`),
because `go:embed` can't reference files outside its own module tree.
After editing `public/` at the repo root, sync it before rebuilding:

```bash
rm -rf standalone/public && cp -r public standalone/public
```

## Environment variables

Same as `server/config.js` / the root `.env.example`: `PORT`, `DATA_DIR`,
`UPLOADS_DIR`, `SITE_PASSWORD`, `COOKIE_SECRET`, `COOKIE_SECURE`,
`MAX_FILE_SIZE_MB`, `FILE_TTL_DAYS`, `MAX_PAD_CONTENT_CHARS`,
`TRUST_PROXY`, `TUNNEL_TOKEN`. Plus three specific to this version:

| Variable | Default | Description |
|---|---|---|
| `DISABLE_TUNNEL` | `false` | `true` to skip the tunnel entirely — local access only |
| `LOG_FILE` | `DATA_DIR/sebinta.log` | where logs are written, in addition to the terminal |

## Out of scope

- Byte-for-byte parity with every header `helmet` (Node) applied by
  default — only the ones that matter for security are replicated (CSP,
  `nosniff`, `X-Frame-Options`, HSTS, etc.), not the full list.
- Log rotation — `LOG_FILE` grows unbounded; for long-running deployments,
  rotate it externally (`logrotate`, etc.) or periodically archive/clear
  the file.
