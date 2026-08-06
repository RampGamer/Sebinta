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
	"strings"

	"github.com/google/uuid"
)

var controlCharsRe = regexp.MustCompile(`[\x00-\x1f\x7f]`)

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

/*
 * POST /api/files?id=... (multipart/form-data, field "file")
 *
 * No metadata cleaning — just like the current Node server, the file is
 * saved exactly as received. It goes through uploads/quarantine/ first
 * (folder name kept for parity) just to allow detecting the real type via
 * magic bytes before moving it to uploads/final/.
 */
func handleFileUpload(cfg *Config, db *sql.DB, hub *wsHub) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, padID string) {
		if !csrfValid(r) {
			writeJSONError(w, http.StatusForbidden, "csrf_invalid")
			return
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

		fileID := uuid.NewString()
		quarantineFile := quarantinePath(cfg, fileID)
		out, err := os.OpenFile(quarantineFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "upload_failed")
			return
		}
		written, err := io.CopyN(out, part, cfg.MaxFileSizeBytes+1)
		out.Close()
		if err != nil && err != io.EOF {
			os.Remove(quarantineFile)
			writeJSONError(w, http.StatusInternalServerError, "upload_failed")
			return
		}
		if written > cfg.MaxFileSizeBytes {
			os.Remove(quarantineFile)
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "file_too_large", "maxMb": cfg.MaxFileSizeMB})
			return
		}

		head, err := readHeadBytes(quarantineFile, 4100)
		if err != nil {
			os.Remove(quarantineFile)
			writeJSONError(w, http.StatusInternalServerError, "upload_processing_failed")
			return
		}
		sniffed := sniff(head, part.FileName())
		storedName := fileID + sniffed.Ext
		finalDest := finalPath(cfg, storedName)
		if finalDest == "" {
			os.Remove(quarantineFile)
			writeJSONError(w, http.StatusInternalServerError, "upload_processing_failed")
			return
		}
		if err := os.Rename(quarantineFile, finalDest); err != nil {
			os.Remove(quarantineFile)
			writeJSONError(w, http.StatusInternalServerError, "upload_processing_failed")
			return
		}
		stat, err := os.Stat(finalDest)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "upload_processing_failed")
			return
		}

		f := &File{
			ID: fileID, PadID: padID,
			OriginalName: sanitizeOriginalName(part.FileName()),
			StoredName:   storedName,
			MimeType:     sniffed.Mime,
			Size:         stat.Size(),
			Kind:         uiKind(sniffed),
			CreatedAt:    nowMs(),
		}
		if err := insertFile(db, f); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "upload_processing_failed")
			return
		}
		hub.broadcastPadChanged(padID, nil)
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
	mux.HandleFunc("POST /api/files", gate(uploadLimiter.middleware(requirePadForFiles(cfg, db, handleFileUpload(cfg, db, hub)))))
	mux.HandleFunc("GET /api/files/{fileId}/download", gate(requirePadForFiles(cfg, db, handleFileDownload(cfg, db))))
	mux.HandleFunc("GET /api/files/{fileId}/preview", gate(requirePadForFiles(cfg, db, handleFilePreview(cfg, db))))
	mux.HandleFunc("DELETE /api/files/{fileId}", gate(requirePadForFiles(cfg, db, handleFileDelete(cfg, db, hub))))
}
