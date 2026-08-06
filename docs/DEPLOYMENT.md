# Deployment guide

Details that don't need to be on the front page: the Cloudflare tunnel walkthrough, the full config reference, day-to-day Docker operations, backup/restore, a few design decisions, and troubleshooting. See the [main README](../README.md) for a quick start.

## Setting up the Cloudflare tunnel

Only needed for a fixed domain (Option A, or Option B/C with `TUNNEL_TOKEN`). Skip this if a random `*.trycloudflare.com` link is fine — that's the zero-config default for both the standalone binary and `docker-compose.yml`.

1. [Cloudflare dashboard](https://dash.cloudflare.com) → **Zero Trust** → **Networks → Tunnels → Create a tunnel**.
2. Connector type **Cloudflared**, name it (e.g. `sebinta`).
3. On **"Install and run a connector"**, copy just the `--token eyJ...` value — that's `TUNNEL_TOKEN` in `.env`. You don't need to run the shown command yourself; Docker/the binary already run `cloudflared` for you.
4. **Route traffic / Public Hostname**: pick a subdomain and your Cloudflare domain, service `HTTP`, address:
   - Docker: `app:3000` (the Docker service name — not `localhost`, `cloudflared` runs inside the Docker network).
   - Standalone binary: `localhost:3000` (or your `PORT`).
5. Save. The public hostname is live within seconds. HTTPS is handled entirely by Cloudflare.

For Docker: `cp .env.example .env`, fill in `TUNNEL_TOKEN`, and switch `docker-compose.yml`'s `cloudflared` `command` from the Quick Tunnel default to `["tunnel", "run"]` (commented right above that line).

## Configuration reference

Same variables for Docker and the standalone binary (`.env` next to either).

| Variable | Default | Notes |
|---|---|---|
| `TUNNEL_TOKEN` | — | Fixed domain. Without it: random Quick Tunnel link. Standalone binary also accepts `--tunnel-token`. |
| `SITE_PASSWORD` | empty | Site-wide password. |
| `MAX_FILE_SIZE_MB` | `500` | Per-file limit. |
| `FILE_TTL_DAYS` | empty | Auto-delete files older than N days. |
| `COOKIE_SECRET` | random on startup | Set a fixed value or restarts invalidate every session. |
| `COOKIE_SECURE` | `true` | Only disable for local HTTP testing. |
| `DISABLE_TUNNEL` | `false` | Standalone only — `true` for local-only. |
| `LOG_FILE` | `DATA_DIR/sebinta.log` | Standalone only. |

## Managing a Docker deployment

```bash
docker compose down                 # stop, keeps data volumes
docker compose up -d                # start / restart
docker compose logs -f              # live logs
docker compose ps                   # health check
```

**Update:**

```bash
git pull && docker compose build app && docker compose up -d
```

**Backup / restore** — data lives in the `sebinta_data` (SQLite) and `sebinta_uploads` (files) volumes (confirm exact names with `docker volume ls | grep sebinta`):

```bash
# Backup
docker run --rm -v sebinta_sebinta_data:/data -v sebinta_sebinta_uploads:/uploads \
  -v "$(pwd)/backups":/backup alpine \
  tar czf /backup/sebinta-backup-$(date +%Y%m%d-%H%M%S).tar.gz -C / data uploads

# Restore
docker compose down
docker run --rm -v sebinta_sebinta_data:/data -v sebinta_sebinta_uploads:/uploads \
  -v "$(pwd)/backups":/backup alpine sh -c "cd / && tar xzf /backup/sebinta-backup-XXXXXXXX-XXXXXX.tar.gz"
docker compose up -d
```

## Design decisions

- **Pad IDs can contain `/`**, so file/password endpoints use `?id=` instead of a path segment — avoids ambiguity between a pad named `notes/files` and the files endpoint for pad `notes`.
- **No metadata cleaning on the server.** Files are stored exactly as received; the [desktop app or CLI](../README.md#metadata-cleaning) clean before upload instead, keeping the server free of heavy dependencies.
- **Cookie-based sessions, no user database.** Simple, but changing (or not fixing) `COOKIE_SECRET` invalidates every session on restart.
- **The standalone Go server embeds the real `cloudflared` binary** (via `go:embed`) rather than linking it as a library — its internals aren't a stable public API.

## Troubleshooting

**Tunnel shows "inactive" on the Cloudflare dashboard.** Check `TUNNEL_TOKEN` for stray whitespace, then `docker compose up -d cloudflared` and check `docker compose logs cloudflared`.

**App never becomes "healthy" (Docker).** `docker compose logs app` — the healthcheck curls `/health` inside the container; failures are usually a startup error or no disk space.

**Turning the site password back off.** Clear `SITE_PASSWORD` in `.env`, then restart (`docker compose up -d app` or relaunch the standalone binary).
