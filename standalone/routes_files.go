package main

import (
	"database/sql"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

var controlCharsRe = regexp.MustCompile(`[\x00-\x1f\x7f]`)

// Chunked uploads (see public/js/upload.js): Cloudflare's tunnel proxy caps
// request bodies at 100MB on the plans this project targets, so the browser
// splits any file into chunks well under that and sends them as separate
// requests, all sharing an uploadId. isSafeUploadID mirrors isSafeStoredName
// — the ID becomes part of a filesystem path (the accumulating quarantine
// file), so it's validated just as strictly.
var safeUploadIDRe = regexp.MustCompile(`^[a-fA-F0-9-]{1,64}$`)

func isSafeUploadID(id string) bool {
	return safeUploadIDRe.MatchString(id)
}

func sanitizeOriginalName(name string) string {
	base := filepath.Base(name)
	if base == "" || base == "." || base == string(filepath.Separator) {
		base = "file"
	}
	cleaned := strings.TrimSpace(controlCharsRe.ReplaceAllString(base, ""))
	if cleaned == "" {
		cleaned = "file"
	}
	if len(cleaned) > 255 {
		cleaned = cleaned[:255]
	}
	return cleaned
}

func contentDispositionHeader(disposition, filename string) string {
	fallback := &strings.Builder{}
	for _, r := range filename {
		if r >= 0x20 && r <= 0x7e && r != '"' {
			fallback.WriteRune(r)
		} else {
			fallback.WriteRune('_')
		}
	}
	return fmt.Sprintf(`%s; filename="%s"; filename*=UTF-8''%s`, disposition, fallback.String(), url.PathEscape(filename))
}

// requirePadForFiles mirrors requireUnlockedPad from server/routes/files.js:
// validates ?id=, ensures the pad exists and isn't locked.
func requirePadForFiles(cfg *Config, db *sql.DB, next func(w http.ResponseWriter, r *http.Request, padID string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		padID := normalizePadID(r.URL.Query().Get("id"))
		if padID == "" {
			writeJSONError(w, http.StatusBadRequest, "invalid_pad_id")
			return
		}
		pad, err := getOrCreatePad(db, padID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		if pad.PasswordHash.Valid && pad.PasswordHash.String != "" && !isPadUnlocked(cfg, r, padID, pad) {
			writeJSONError(w, http.StatusLocked, "pad_locked")
			return
		}
		next(w, r, padID)
	}
}

// finalizeUpload runs once the full file is in quarantineFile (either from a
// single-shot upload, or the last chunk of a chunked one): sniffs the real
// type via magic bytes, moves it to uploads/final/, and records it in the
// DB. Removes quarantineFile itself on any failure past this point.
func finalizeUpload(cfg *Config, db *sql.DB, hub *wsHub, padID, quarantineFile, originalName string) (*File, string) {
	head, err := readHeadBytes(quarantineFile, 4100)
	if err != nil {
		os.Remove(quarantineFile)
		return nil, "upload_processing_failed"
	}
	sniffed := sniff(head, originalName)
	fileID := uuid.NewString()
	storedName := fileID + sniffed.Ext
	finalDest := finalPath(cfg, storedName)
	if finalDest == "" {
		os.Remove(quarantineFile)
		return nil, "upload_processing_failed"
	}
	if err := os.Rename(quarantineFile, finalDest); err != nil {
		os.Remove(quarantineFile)
		return nil, "upload_processing_failed"
	}
	stat, err := os.Stat(finalDest)
	if err != nil {
		return nil, "upload_processing_failed"
	}

	f := &File{
		ID: fileID, PadID: padID,
		OriginalName: sanitizeOriginalName(originalName),
		StoredName:   storedName,
		MimeType:     sniffed.Mime,
		Size:         stat.Size(),
		Kind:         uiKind(sniffed),
		CreatedAt:    nowMs(),
	}
	if err := insertFile(db, f); err != nil {
		return nil, "upload_processing_failed"
	}
	hub.broadcastPadChanged(padID, nil)
	return f, ""
}

/*
 * POST /api/files?id=...[&uploadId=...&chunkIndex=N&totalChunks=N] (multipart/form-data, field "file")
 *
 * No metadata cleaning — just like the current Node server, the file is
 * saved exactly as received. It goes through uploads/quarantine/ first
 * (folder name kept for parity) just to allow detecting the real type via
 * magic bytes before moving it to uploads/final/.
 *
 * Chunked uploads: the browser (see public/js/upload.js) splits large files
 * into pieces well under Cloudflare's 100MB per-request cap and sends
 * uploadId/chunkIndex/totalChunks as query params — so which chunk this is
 * can be known before touching the multipart body at all. Older/other
 * clients (the sebinta-clean CLI's `send` command, curl, ...) that never
 * send them keep working exactly as before: that's the chunked==false path.
 */
func handleFileUpload(cfg *Config, db *sql.DB, hub *wsHub) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, padID string) {
		if !csrfValid(r) {
			writeJSONError(w, http.StatusForbidden, "csrf_invalid")
			return
		}

		q := r.URL.Query()
		uploadID := q.Get("uploadId")
		chunkIndex, _ := strconv.Atoi(q.Get("chunkIndex"))
		totalChunks, _ := strconv.Atoi(q.Get("totalChunks"))
		chunked := uploadID != "" && totalChunks > 1

		if chunked && !isSafeUploadID(uploadID) {
			writeJSONError(w, http.StatusBadRequest, "invalid_upload_id")
			return
		}
		if chunked && (chunkIndex < 0 || chunkIndex >= totalChunks) {
			writeJSONError(w, http.StatusBadRequest, "invalid_chunk_index")
			return
		}

		// Only the first request of an upload (the whole file, or chunk 0)
		// counts against uploadLimiter — otherwise a single large file, split
		// into dozens of chunk requests, would exhaust the abuse limit on its
		// own and block the rest of its own chunks.
		if chunkIndex == 0 {
			ip := clientIP(r, cfg)
			if !uploadLimiter.allow(ip) {
				writeJSONError(w, http.StatusTooManyRequests, "too_many_uploads")
				return
			}
		}

		mr, err := r.MultipartReader()
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "upload_failed")
			return
		}
		var part *multipart.Part
		for {
			p, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				writeJSONError(w, http.StatusBadRequest, "upload_failed")
				return
			}
			if p.FormName() == "file" && p.FileName() != "" {
				part = p
				break
			}
			p.Close()
		}
		if part == nil {
			writeJSONError(w, http.StatusBadRequest, "no_file")
			return
		}
		defer part.Close()

		var quarantineFile string
		var openFlags int
		if chunked {
			quarantineFile = quarantinePath(cfg, "chunk-"+uploadID)
			openFlags = os.O_CREATE | os.O_WRONLY
			if chunkIndex == 0 {
				openFlags |= os.O_TRUNC
			} else {
				openFlags |= os.O_APPEND
			}
		} else {
			quarantineFile = quarantinePath(cfg, uuid.NewString())
			openFlags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
		}

		out, err := os.OpenFile(quarantineFile, openFlags, 0o644)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "upload_failed")
			return
		}
		priorSize := int64(0)
		if chunked && chunkIndex > 0 {
			if st, err := out.Stat(); err == nil {
				priorSize = st.Size()
			}
		}
		budget := cfg.MaxFileSizeBytes - priorSize + 1
		if budget < 1 {
			budget = 1
		}
		written, err := io.CopyN(out, part, budget)
		out.Close()
		if err != nil && err != io.EOF {
			os.Remove(quarantineFile)
			writeJSONError(w, http.StatusInternalServerError, "upload_failed")
			return
		}
		if priorSize+written > cfg.MaxFileSizeBytes {
			os.Remove(quarantineFile)
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "file_too_large", "maxMb": cfg.MaxFileSizeMB})
			return
		}

		if chunked && chunkIndex < totalChunks-1 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "chunkIndex": chunkIndex})
			return
		}

		f, errCode := finalizeUpload(cfg, db, hub, padID, quarantineFile, part.FileName())
		if errCode != "" {
			writeJSONError(w, http.StatusInternalServerError, errCode)
			return
		}
		writeJSON(w, http.StatusCreated, fileToJSON(f))
	}
}

func readHeadBytes(path string, length int) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, length)
	n, err := f.Read(buf)
	if err != nil && err != io.EOF {
		return nil, err
	}
	return buf[:n], nil
}

func handleFileDownload(cfg *Config, db *sql.DB) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, padID string) {
		fileID := r.PathValue("fileId")
		f, err := getFile(db, padID, fileID)
		if err != nil || f == nil {
			writeJSONError(w, http.StatusNotFound, "not_found")
			return
		}
		path := finalPath(cfg, f.StoredName)
		fh, err := os.Open(path)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "not_found")
			return
		}
		defer fh.Close()
		stat, _ := fh.Stat()

		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Type", f.MimeType)
		w.Header().Set("Content-Disposition", contentDispositionHeader("attachment", f.OriginalName))
		http.ServeContent(w, r, "", stat.ModTime(), fh)
	}
}

// SVG is never previewed inline (it can contain <script>); only raster
// images and video get a preview.
func handleFilePreview(cfg *Config, db *sql.DB) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, padID string) {
		fileID := r.PathValue("fileId")
		f, err := getFile(db, padID, fileID)
		if err != nil || f == nil {
			writeJSONError(w, http.StatusNotFound, "not_found")
			return
		}
		if f.Kind != "image" && f.Kind != "video" {
			writeJSONError(w, http.StatusUnsupportedMediaType, "preview_not_supported")
			return
		}
		path := finalPath(cfg, f.StoredName)
		fh, err := os.Open(path)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "not_found")
			return
		}
		defer fh.Close()
		stat, _ := fh.Stat()

		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Type", f.MimeType)
		w.Header().Set("Content-Disposition", contentDispositionHeader("inline", f.OriginalName))
		http.ServeContent(w, r, "", stat.ModTime(), fh)
	}
}

func handleFileDelete(cfg *Config, db *sql.DB, hub *wsHub) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, padID string) {
		if !csrfValid(r) {
			writeJSONError(w, http.StatusForbidden, "csrf_invalid")
			return
		}
		fileID := r.PathValue("fileId")
		removed, err := deleteFile(db, padID, fileID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		if removed == nil {
			writeJSONError(w, http.StatusNotFound, "not_found")
			return
		}
		deleteStoredFile(cfg, removed.StoredName)
		hub.broadcastPadChanged(padID, nil)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func registerFileRoutes(mux *http.ServeMux, cfg *Config, db *sql.DB, hub *wsHub, gate func(http.HandlerFunc) http.HandlerFunc) {
	// uploadLimiter is applied inside handleFileUpload itself (only against
	// the first request of an upload), not wrapped here — see the comment
	// there.
	mux.HandleFunc("POST /api/files", gate(requirePadForFiles(cfg, db, handleFileUpload(cfg, db, hub))))
	mux.HandleFunc("GET /api/files/{fileId}/download", gate(requirePadForFiles(cfg, db, handleFileDownload(cfg, db))))
	mux.HandleFunc("GET /api/files/{fileId}/preview", gate(requirePadForFiles(cfg, db, handleFilePreview(cfg, db))))
	mux.HandleFunc("DELETE /api/files/{fileId}", gate(requirePadForFiles(cfg, db, handleFileDelete(cfg, db, hub))))
}
