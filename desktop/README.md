# sebinta-desktop

Desktop app (Electron) for Sebinta. Opens the same interface you'd see in a
normal browser — same pad, same text, same files, real-time sync included
— but intercepts every upload to clean metadata locally, **before** the
file leaves your computer:

- **Office** (`.docx`/`.xlsx`/`.pptx`): removes `docProps/core.xml`,
  `docProps/app.xml`, `docProps/custom.xml`, the embedded thumbnail, and
  the entire `customXml/` folder — where classification/DLP tools like
  Titus or Microsoft Purview store tags outside the usual Office
  properties. If those tags are detected, cleaning is **always applied**,
  regardless of the toggle.
- **PDF**: cleans the Info dictionary (author, title, dates…) and the XMP
  metadata stream.
- Any other file type (image, video, audio, legacy Office
  `.doc`/`.xls`/`.ppt`) passes through unchanged — same as the web version,
  which doesn't clean anything.

The cleaning logic itself reuses the same code already validated in the Go
CLI (`../cli/officeclean.go`) and the old browser-side PDF cleaner, but
runs in plain Node in Electron's main process — outside any Web Worker —
which avoids the pitfalls (CSP, stale worker cache) that made cleaning in
the browser unreliable.

## Install and run

```bash
cd desktop
npm install
npm start
```

The first time, it asks for your Sebinta server's URL (the same Cloudflare
tunnel domain you already use in the browser, e.g.
`https://notes.yourdomain.com`). It's remembered from then on — just open
the app and you're on your pad, like opening a browser. To switch servers
later, use the ⚙ button in the toolbar at the top of the window.

## Package (installer)

```bash
npm run dist
```

Produces Linux (AppImage), Windows (portable `.exe` — no installer, no
copy under `AppData\Local`, just run it), and macOS (`.zip` of the `.app`,
x64 and arm64 — not `.dmg`, which depends on macOS-only tooling). The
macOS binaries aren't signed or notarized (no Apple certificate);
Gatekeeper will block opening them by default — right-click → Open the
first time, or `xattr -d com.apple.quarantine Sebinta.app` after
unzipping.
