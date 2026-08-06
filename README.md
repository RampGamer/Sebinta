<p align="center">
  <img src="docs/screenshots/logo.png" width="96" alt="Sebinta logo">
</p>

<h1 align="center">Sebinta</h1>

<p align="center">
  A Dontpad-style pad for text and files. Open a URL, start typing, drop a file — that's it.
</p>

<p align="center">
  <img src="docs/screenshots/landing.png" width="820" alt="Sebinta landing page, with one-click downloads for the desktop app and standalone server">
</p>

No accounts, no login. Open `https://yourdomain.com/whatever-you-want` and the pad is created — or opened, if it already exists. Autosaved text, drag-and-drop uploads, near-real-time sync across every device with the same pad open. Runs as a Docker service, a single Go binary, or a desktop app — pick one below. The landing page itself has one-click downloads for the binary and the desktop app, always pointing at the latest release.

## Features

- Any URL is a pad. Text autosaves, nested paths (`team/notes`) work as folders.
- Real-time sync (WebSocket, polling fallback), drag-and-drop/paste uploads, image lightbox.
- Optional site-wide password and per-pad password.
- Type-checked by file content (not extension), CSRF protection, rate limiting, no external CDNs.
- The server keeps file metadata as-is — see [Metadata cleaning](#metadata-cleaning) if you need it stripped before upload.

<p align="center">
  <img src="docs/screenshots/pad.png" width="700" alt="A pad with notes and three uploaded files">
  &nbsp;
  <img src="docs/screenshots/desktop-app.png" width="700" alt="The desktop app">
</p>

## Getting started

Three independent ways to run it — same API, same data, mix and match.

### Option A — Docker

```bash
cp .env.example .env   # optionally set TUNNEL_TOKEN, see docs/DEPLOYMENT.md
./start.sh
```

Builds the image, brings up `app` + `cloudflared`, and prints the public URL once healthy.

### Option B — Standalone binary

One static Go binary, `cloudflared` embedded, nothing else to install. Grab it from [Releases](/RampGamer/Sebinta/releases) — or the landing page's download buttons — then:

```bash
chmod +x sebinta-server-*        # downloads lose the executable bit
./sebinta-server-*
```

Starts the server, opens a Cloudflare Quick Tunnel, and prints the public URL. `DISABLE_TUNNEL=true` to stay local-only. Details: [`standalone/README.md`](standalone/README.md).

### Option C — Desktop app

Electron client, same interface as the browser, plus local Office/PDF metadata cleaning before upload. Linux (AppImage), Windows (portable `.exe`), macOS (Intel + Apple Silicon) — from [Releases](/RampGamer/Sebinta/releases) or the landing page. Details: [`desktop/README.md`](desktop/README.md).

## Metadata cleaning

The server and web page store files exactly as received. To strip author names, GPS data, or DLP tags before a file leaves your machine, clean it first with:

- **Desktop app** — Office (`.docx`/`.xlsx`/`.pptx`) and PDF, cleaned locally before upload. [`desktop/README.md`](desktop/README.md)
- **CLI** (`sebinta-clean`) — same cleaning, scriptable from a terminal. [`cli/README.md`](cli/README.md)

Other file types upload unchanged — neither tool covers those today.

## Project structure

```
sebinta/
├── server/       # Node/Express server (Docker deployment)
├── public/       # frontend — shared by server/ and standalone/
├── standalone/    # Go port — single binary, no Docker
├── desktop/        # Electron client, local metadata cleaning
└── cli/              # sebinta-clean: scriptable metadata cleaning
```

Each of `standalone/`, `desktop/`, and `cli/` has its own README. Full deployment details — Cloudflare tunnel setup, config reference, Docker operations, backup/restore, troubleshooting — are in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
