# filepad-clean

A command-line tool, written in Go, that strips metadata from Office
documents (`.docx`/`.xlsx`/`.pptx`) **entirely outside the browser**,
before any network contact. It's a pure-Go (dependency-free)
reimplementation of the same logic already used in
`public/js/metadata/office-clean.js` and `server/services/officeClean.js`
(both retired — see the root README): replaces `docProps/core.xml` and
`docProps/app.xml` with empty versions, removes `docProps/custom.xml`, the
embedded thumbnail, and the entire `customXml/` folder (Custom XML Parts —
where classification/DLP tools like Titus or Microsoft Purview store tags
outside the usual Office properties), and fixes up the `.rels`/
`[Content_Types].xml` files so the document still opens without Office
asking to "repair" it.

Doesn't handle legacy `.doc`/`.xls`/`.ppt` (binary OLE2 format).

## Build

Requires Go 1.21+. From this folder:

```bash
go build -o filepad-clean .
```

### Cross-compile for all three OSes

```bash
GOOS=linux   GOARCH=amd64 go build -o dist/filepad-clean-linux-amd64     .
GOOS=darwin  GOARCH=arm64 go build -o dist/filepad-clean-macos-arm64     .
GOOS=darwin  GOARCH=amd64 go build -o dist/filepad-clean-macos-amd64     .
GOOS=windows GOARCH=amd64 go build -o dist/filepad-clean-windows-amd64.exe .
```

Each command produces a single dependency-free binary — just copy it and run it.

## Usage

### Just clean (never touches the network)

```bash
./filepad-clean clean report.docx
# writes report.clean.docx and lists what was removed
```

### Clean and upload straight to a Filepad pad

```bash
./filepad-clean send -server https://notes.example.com -pad project-x report.docx

# if the site has a global password:
./filepad-clean send -server https://notes.example.com -pad project-x -site-password PASSWORD report.docx

# if that specific pad has its own password:
./filepad-clean send -server https://notes.example.com -pad project-x -pad-password PASSWORD report.docx
```

`send` cleans the file locally first (same logic as `clean`), then
authenticates against the server (site/pad password, if applicable) and
uploads via `POST /api/files` — the same endpoint the browser uses,
including the double-submit-cookie CSRF token the API requires.
