# Changelog — August 7, 2026

Summary of today's work on Sebinta: six releases, `v1.8.6`–`v1.8.11`, covering a Windows console bug, a chunked-upload feature (with two follow-up fixes), several pad-password UX/security fixes, and one live-site debugging saga that turned out not to be a code bug at all.

## Windows: ANSI colors in the tunnel-URL highlight

- `printHighlight` (the tunnel URL line printed on startup) relies on ANSI escape codes to render in color. The native Windows console (`cmd.exe`, legacy PowerShell hosts) doesn't interpret those unless a process explicitly asks via `ENABLE_VIRTUAL_TERMINAL_PROCESSING` — unlike every Unix terminal and Windows Terminal, which handle it automatically. Fixed by calling that Windows API at startup (`standalone/console_windows.go`, no-op elsewhere). `v1.8.6`.

## Debugging saga: "the site doesn't show the landing page, it goes straight into a pad"

Not a code bug, but worth recording since it took real investigation to rule out:

- First hypothesis (wrong): a stale release binary. Ruled out — verified the exact `v1.8.5` binary on GitHub Releases byte-for-byte, matched current source exactly.
- The browser console showed `GET /api/pad?id=%2F` (i.e. `padId` was the literal string `"/"`, not empty) and `app.js` stack-trace line numbers that didn't match any commit in this repo's history. Comparing the live `app.js` byte-for-byte revealed the real cause: the production domain (`sebinta.org`) was actually serving **SeFinta** (a separate private fork — see project memory) — recognizable from `window.SeFinta`, a `PAD_BASE = '/pad/'` prefix-stripping regex, and `sefinta-theme` in `localStorage`. Visiting bare `/` there left `padId` as `"/"` (the regex only strips a `/pad/` prefix), which is truthy, so the empty-padId/landing-screen branch never ran.
- Once the correct `v1.8.6` Sebinta binary was confirmed running and bound to the tunnel's port, the *same* wrong content kept showing — this time because Cloudflare's edge was serving a ~50-minute-old **cached** copy of `/js/app.js` (`cf-cache-status: HIT`) from before the switch. Fixed by purging the Cloudflare cache. No code change was needed for either half of this.

## Chunked uploads (files over Cloudflare's 100MB cap)

- Cloudflare's tunnel/proxy caps request bodies at 100MB on the plans this project targets — but only on a **custom domain** (a named tunnel bound to your own zone); the free Quick Tunnel (`*.trycloudflare.com`) isn't bound to that zone-level plan limit, which is why it worked there already.
- Files bigger than 8MB are now split client-side into 8MB pieces and sent as separate sequential requests sharing an `uploadId`, `chunkIndex`, and `totalChunks` (passed as query params, so the server knows which chunk this is before touching the multipart body at all). The server appends each chunk to one accumulating file per `uploadId` and only runs the sniff/finalize/DB-insert logic once the last chunk lands — the max-file-size check still applies across the whole upload, not per chunk. Implemented in both the standalone Go server (`routes_files.go`) and the Node server (a custom `multer` storage engine, since multer's default always overwrites rather than appends).
- Entirely invisible client-side: same button, same drag&drop, same progress bar. Files under 8MB (and the `sebinta-clean` CLI's `send` command) still take the exact single-request path as before.
- Verified with a real 120MB upload against the live `sebinta.org` site through the actual Cloudflare tunnel — all 15 chunks accepted, downloaded back byte-identical (SHA256 match), test file and pad cleaned up afterward. `v1.8.7`.
- **Follow-up fix**: a chunk's `XMLHttpRequest` had no `timeout`, so a connection that stalled without firing `load`/`error`/`abort` would freeze the whole upload forever on that chunk's percentage, with no error shown — this is what a 200MB upload getting "stuck at 1%" turned out to be. Added a 60s per-chunk timeout that feeds into the existing retry logic instead of hanging indefinitely. `v1.8.8`.
- **Follow-up UX**: upload progress now shows a smoothed live transfer speed and ETA ("2.9 MB/s · 12s left"), and a cancel button that aborts the in-flight chunk and stops the loop cleanly (no orphaned file record left behind). Verified in a real headless browser (Playwright + system Chromium, with CDP upload throttling to keep a 40MB test file observably in progress) — speed/ETA render correctly, canceling shows "Upload canceled." with nothing left in the file grid, and a left-alone upload still completes normally. Styled for both the sober and notebook themes. `v1.8.9`.

## Standalone server: `--local` and a real `--help`

- `--local` is shorthand for `DISABLE_TUNNEL=true` — one flag instead of an env var for the common case of running purely on localhost.
- `flag.Usage` was Go's bare default (just each flag's one-line description, no context). Replaced with a proper help screen: what the binary does, usage, flags, worked examples, and a pointer to the env vars for everything else — mirrors the style `cli/main.go` already has for `sebinta-clean`. `v1.8.9`.

## Releases no longer include a prebuilt `sebinta-clean`

- The CLI (`sebinta-clean`) stays fully buildable from `cli/` source (`cli/README.md` already only documented that path — nothing there needed to change), but is no longer cross-compiled and attached to GitHub Releases. Releases from `v1.8.7` on include just the standalone server and the desktop app, plus `SHA256SUMS.txt`.

## Pad-password fixes and security hardening

- **Unlock-prompt race**: setting a password could immediately flash the unlock prompt back at the person who just set it — a poll-driven `refresh()` dispatched moments before the password was set could resolve just after, carrying the pre-unlock cookie and reporting `locked:true`. Fixed with an `unlockToken` bumped on every local unlock/password-set; `refresh()` discards a stale `locked:true` verdict if the token moved on since the request was sent. `v1.8.6`.
- **Dedicated brute-force guard**: 5 wrong guesses against the same pad now locks that (IP, pad) pair out for 30s, on top of the existing broader per-IP limit — a success clears the count, so a legitimate retry after a typo doesn't count against it. `v1.8.6`.
- **"Remove password" button**: removing a pad's password already worked (submit the password form with an empty field, per the modal's hint text), but nothing surfaced that clearly — added an explicit "Remove password" button, shown only when the pad currently has one. `v1.8.10`.
- **Real rate-limit countdowns**: every 429 response (wrong-password lockout, and the broader per-IP guards on login/pad-password/uploads/pad-writes) now returns `retryAfterSeconds`, and the client shows a live "Too many attempts. Try again in 30s." that ticks down every second, instead of a static "wait a bit". Loosened the blanket pad-password limiter from 15 to 60 requests/10min while at it — brute-forcing specifically is the dedicated 5-guesses/30s lock's job now, so this one no longer needs to double as that and can afford to not trip on normal use. `v1.8.10`.
- **Mass pad-hijacking mitigation**: knowing a pad's name is already enough to read/edit/delete it (this app's whole no-accounts model), but nothing previously stopped a script from working through a wordlist of common pad names and password-locking every one it found — denying real users access with no recovery path. Added a per-IP limiter capping *distinct* newly-protected pads at 20/hour; changing or removing a password on a pad you already hold access to doesn't count, so normal use of your own pads is unaffected. Verified end to end on both servers: pads 1–20 from one IP succeed, 21+ get `429 too_many_new_locks` with a countdown, and managing an already-owned pad keeps working afterward. `v1.8.11`.

# Changelog — August 6, 2026

Summary of today's work on Sebinta (formerly Filepad), from the rebrand through releases `v1.4.0`–`v1.8.2`.

## Rebrand: Filepad → Sebinta

- Name, icon (spiral notebook), window titles, logs, IPC channels, and data filenames (`filepad.db`/`filepad.log` → `sebinta.db`/`sebinta.log`) updated across every version: web, Node server, standalone Go server, CLI, and desktop app.
- GitHub repository renamed twice: `RampGamer/filepad` → `RampGamer/sebinta` → `RampGamer/Sebinta` (capitalized). GitHub automatically redirects old clones and links.
- `go.mod`, README links, and module names updated to the new repository path.

## Pad header and desktop tabs

- The pad path became an editable field (📂 + text box + "Go") on the same line as Password/Clear pad, instead of a fixed name with a separate metadata-cleaning button.
- The editor lost its visible box (no border, no background contrast) and now fills the whole window.
- The desktop app gained a browser-style tab system — one `<webview>` per tab, each with its own real-time connection, switching is instant. The ⚙ button (change server) moved to the left of the tab strip, since it's a window-level setting, not a specific pad's. Open tabs are saved across launches.
- Fixed a CSS specificity bug where the landing screen (choose a pad name) sometimes didn't disappear after a pad loaded (`[hidden]` losing to an author rule with `display:flex`).

## "Sebinta" logo and the notebook-theme easter egg

- Added a centered "sebinta" logo in the header (3-column grid: pad field + status on the left, logo centered, actions on the right), with "bin" highlighted like a text marker — a direct reference to the name's etymology (Sebenta + **bin**ary).
- Clicking the logo is an easter egg: it swaps the whole page to a "notebook" theme — ruled paper with a red margin in the editor, files as colored post-its, Password/Clear pad buttons as ink stamps, a notebook spiral in the left margin. All via a `body.theme-notebook` class reskinning the real DOM (no duplicated markup). The choice is saved per browser (`localStorage`) and applies before the first render, so there's no flash of the wrong theme.
- After comparing the real implementation side by side with the design mockup, several fidelity issues were fixed:
  - The theme's fonts (Caveat, Permanent Marker) were failing silently — `/fonts/*` returned the pad page instead of the font file, because the static route was missing and "fonts" wasn't in the list of reserved segments for pad IDs. Fixed in parallel in the Node server (`server/index.js`, `services/padStore.js`) and the standalone Go server (`main.go`, `padstore.go`).
  - The notebook theme was initially just a small, centered card with a dark desk around it — fixed to fill the whole window (just like the normal theme), keeping the spiral, ruled paper, and shadow.
  - A CSS paint-order bug made the spiral show up as a solid dark bar instead of circles — fixed by giving `main`'s padding area its own background.
  - Sizes and colors adjusted to match the mockup: bigger logo, "Go →" arrow, Password/Clear pad buttons with the mockup's stamp colors (not the app's blue), files bar with the upload button integrated.
- The desktop app's tabs (an Electron window separate from each tab's page) were synced with the easter egg: each tab tells the main window its theme via `ipc-message`, and the tab strip (⚙ + tabs) switches to the post-it look whenever the active tab is in notebook mode, going back to normal dark for tabs still in the sober theme.

## Landing downloads, notebook-theme legibility, and fixes

- **Root page "/"**: below the "Open pad" form, a new section with two groups — Client (desktop app) and Server (standalone binary) — each with 4 icons (Windows, Linux, macOS, GitHub), original logos as inline SVG (not emoji). Links are resolved live via the GitHub API (`releases/latest`), so they never get stuck on one version as new releases ship; without JS or if the API fails (e.g. the repo is still private), they fall back to the releases page instead of a dead link. macOS defaults to Apple Silicon, with an "Intel" link underneath. Required opening `connect-src` in the CSP for `api.github.com`, in parallel in the Node server (`server/middleware/security.js`) and the standalone Go server (`standalone/security.go`).
- **Bigger "sebinta" logo in the sober theme** — `1.05rem→1.4rem`, icon `22px→28px`.
- **Notebook theme much more readable** — not just the pad name and the "live" status (which were small and low-contrast), but also the action buttons, the "FILES" header, the upload button, the drag-files hint, and the file card name/size. The "uploading…" progress bar didn't even have paper styling — it was the base UI's dark box floating over the paper; now it has the same dashed post-it look as the other sections. In the desktop app's tabs, bigger text (`1rem→1.3rem`) when the active tab is in notebook theme.
- **Desktop tabs' "✕" button** now always anchored to the tab's right edge (`flex:1 1 auto` on the name), instead of right after the name — before, on short names, it sat flush against the text with dead space to the edge.
- **Fixed a CSP bug**: the inline script in `pad.html`'s `<head>` that applied the notebook theme saved in `localStorage` was being blocked by `script-src 'self'` — the theme never survived a reload, it only stayed active until clicking the logo again. Moved to `public/js/theme-init.js` (external file, same position right after `<body>`, no flash of the wrong theme).
- **README simplified and in English** — the main README went from ~235 to under 80 lines; the Cloudflare tunnel walkthrough, config reference, Docker operations, backup/restore, and troubleshooting moved to `docs/DEPLOYMENT.md`. Landing screenshot updated to show the new downloads section.

## Pad-password fixes, --port on the standalone server, and downloads-section tweaks

- **"Protected" badge not updating without F5**: setting (or removing) a pad's password never notified other clients already connected via WebSocket — only text/file changes did. Now `POST /api/pad/password` also fires `broadcastPadChanged`, in parallel in the Node server and the standalone Go server. Confirmed with two browsers on the same pad: the badge appears/disappears, and anyone without the password gets locked out, no reload needed.
- **Wrong password on unlock sent you to `/login?next=...`**: `/api/pad/unlock` returned `401` on a wrong password, and the frontend's `api()` treats any `401` as "site auth required" and redirects — so the next attempt (with the correct password) got lost in that wrong flow. Changed to `403` in both servers; confirmed that getting it wrong and then right now unlocks on the first correct try.
- **`--port` on the standalone server** — `./sebinta-server --port 8080` (takes priority over `PORT`/`.env`).
- **Landing downloads**: Client and Server are no longer side by side — now one above the other — and the icons got much bigger (squares, 22px→36px). Kept the live resolution via the GitHub API (not a static link to `releases/latest`, nor a hardcoded version in the HTML) — binary filenames include the version, so only a link built from the latest release via the API guarantees a direct download that doesn't get stuck on an old version.

## Web app and desktop app translated to English, and password self-lockout fix

- **Interface fully in English**: `public/pad.html`, `login.html`, `app.js`, `upload.js`, `login.js`, and the desktop app (`shell.html`, `shell.js`, `settings.html`) had all been Portuguese since the start of the project — only the main README and the CHANGELOG had been handled before. Translated visible text (buttons, modals, toasts, titles, placeholders); code comments were initially left in Portuguese on purpose (not visible to anyone using the site/app) — see the entry below, where the whole repository (including comments) was translated too.
- **README screenshots updated** (`docs/screenshots/landing.png`, `pad.png`, `desktop-app.png`) to reflect the English interface and the new downloads section.
- **Fix: setting a password immediately locked out the person who set it.** The earlier fix (broadcasting on password set) had a race condition — the WebSocket message reached the author themselves before the browser applied the HTTP response's unlock cookie, and the `refresh()` that triggered saw them as locked right after setting the password. Fixed by reversing the order: the HTTP response (with the cookie) is always sent before the broadcast, in both servers.

## `--tunnel-token` flag on the standalone server

- The standalone binary could only get a Cloudflare named-tunnel token (for a fixed custom domain) via `TUNNEL_TOKEN`/`.env` — added `--tunnel-token`, mirroring `--port` (takes priority over the environment/`.env`). The domain itself isn't something the binary configures — it's tied to the tunnel token on Cloudflare's side (named tunnel + a "Public Hostname" route to your domain, set up once in the Cloudflare dashboard); the flag just makes it easy to pass that token in without a `.env` file. Verified end-to-end: passing a token via the flag reaches `cloudflared` correctly (confirmed by it rejecting a deliberately invalid test token with the expected error, instead of falling back to Quick Tunnel).

## Full repository translated to English

- **Every remaining piece of Portuguese text translated**: code comments across the Node server, the standalone Go server, the CLI, the desktop app, and the frontend; CLI `--help`/usage text and error messages; server/CLI console/log output; config file comments (`.env.example`, `docker-compose.yml`, `start.sh`, `Dockerfile`, `.gitignore`); and this changelog itself. User-visible strings had already been translated in the previous entry — this pass covered what a developer browsing the source or running the tools from a terminal would see.
- **GitHub repo metadata**: the "About" description and topics (previously unset) are now in English too — separate from the README, set via repo settings.

## Second translation pass: everything my accent-only check had missed

- The first full-repo sweep only searched for accented characters, which missed a good chunk of Portuguese written without diacritics (`ficheiro`, `nao`, `sao`, `nunca`, `sempre`, `espelha`, section-header comments like `--- password do pad ---`, etc.). A second, broader sweep (comment-line function words + a larger unaccented word list) caught: `server/config.js` (entirely missed on the first pass), `standalone/padstore.go` (entirely missed), plus stray lines in `public/js/app.js`, `public/css/style.css`, `server/routes/files.js`, `server/services/storage.js`, `server/ws.js`, `standalone/routes_files.go`, `standalone/routes_pad.go`, `standalone/storage.go`, and `desktop/renderer/shell.js`.
- Two of those were actually **user-visible**, not just comments: the fallback filename used when an upload has no usable name was the literal string `"ficheiro"` in both the Node and Go servers — now `"file"`.
- Also translated the root and desktop `package.json` `description` fields, which had no diacritics either and so were also missed by the first pass.
- Confirmed with three independent sweep methods (accented characters, comment-line Portuguese function words, and a broad unaccented word list) that no Portuguese text remains anywhere in the tracked repository.

## Published releases

| Version | Highlights |
|---|---|
| `v1.4.0` | Full rebrand to Sebinta |
| `v1.5.0` | Centered logo + notebook-theme easter egg (first version) |
| `v1.6.0` | Binary filenames now include the version; notebook-theme fidelity fixes |
| `v1.7.0` | Notebook theme fills the whole screen; desktop tabs synced with the theme |
| `v1.8.0` | Downloads (Client/Server) on the landing page; more readable notebook theme; tab "✕" fix; theme CSP fix; simplified README |
| `v1.8.1` | Fix for the password badge needing F5; fix for the redirect to /login on a wrong password; `--port` on the standalone server; stacked downloads with bigger icons |
| `v1.8.2` | Web app and desktop app translated to English; fix for the password self-lockout; updated README screenshots |
| `v1.8.3` | Full repository translated to English (code comments, CLI, logs, config files, changelog) |
| `v1.8.4` | Second translation pass (accent-only check had missed unaccented Portuguese); GitHub repo description/topics set in English |
| `v1.8.5` | `--tunnel-token` flag on the standalone server, for a fixed custom domain without a `.env` file |
| `v1.8.6` | ANSI colors now work in the native Windows console (`cmd.exe`/legacy PowerShell); fixed the unlock prompt flashing right after setting a pad password; 5-failed-attempts/30s rate limit on pad-password guessing |
| `v1.8.7` | Uploads are split into 8MB chunks client-side, so files over Cloudflare's 100MB per-request cap work on a custom tunnel domain. Server-only change — the desktop app binaries in this release are unchanged from `v1.8.6`. The CLI (`sebinta-clean`) is no longer published as a prebuilt binary from this release on |
| `v1.8.8` | Fixed chunked uploads hanging forever on a stalled chunk (no XHR timeout, so a dropped connection never triggered the existing retry logic). Server-only change — desktop app binaries unchanged from `v1.8.6` |
| `v1.8.9` | Upload progress now shows live speed/ETA and a cancel button. Standalone server: `--local` flag (shorthand for `DISABLE_TUNNEL=true`) and a real `--help` screen. Desktop app binaries unchanged from `v1.8.6` |
| `v1.8.10` | Dedicated "Remove password" button in the pad-password modal. All rate limits now return a real retry countdown ("Try again in 30s.") instead of a generic "wait a bit"; loosened the blanket pad-password limiter (15→60/10min) now that brute-force guessing has its own dedicated 5-guesses/30s lock. Desktop app binaries unchanged from `v1.8.6` |
| `v1.8.11` | Mitigates a mass pad-hijacking risk: a script could work through a wordlist of pad names and password-lock every one it found, since setting a password never required more than knowing the pad's name (same as reading/editing it). Now capped at 20 newly-protected pads/hour per IP — managing your own already-protected pads is unaffected. Desktop app binaries unchanged from `v1.8.6` |

Through `v1.8.6`, each release included: standalone Go server (`sebinta-server-vX.Y.Z-*`, 4 platforms), metadata-cleaning CLI (`sebinta-clean-vX.Y.Z-*`, 4 platforms), and Electron desktop app (`Sebinta-desktop-vX.Y.Z-*`: AppImage, portable `.exe`, macOS x64/arm64 `.zip`), plus a `SHA256SUMS.txt`. From `v1.8.7` on, the CLI is no longer published as a prebuilt binary — build it from `cli/` yourself if you need it (see `cli/README.md`). Releases now include just the standalone server and the desktop app, plus `SHA256SUMS.txt`.

## Issues reported and resolved today

- **"The Linux version doesn't open"**: not a bug — the standalone binary had actually started successfully on the first try and was running in the background (no visible terminal); subsequent attempts failed with "port already in use" for that reason. Documented the missing step (`chmod +x`, lost on download) in the main README, in `standalone/README.md`, and in the `v1.7.0` release notes.
- **Desktop app's AppImage**: failed with `dlopen(): error loading libfuse.so.2` on distros that no longer ship `libfuse2` by default (Kali, Debian/Ubuntu 22.04+, Fedora, among others — the AppImage's default runtime needs the FUSE2 compatibility lib, not FUSE3). Confirmed that `./Sebinta-*.AppImage --appimage-extract-and-run` resolves it without needing root. Documented in `desktop/README.md` and in the `v1.7.0` release notes.
