package main

import (
	"database/sql"
	"net/http"
)

func fileToJSON(f *File) map[string]any {
	return map[string]any{
		"id": f.ID, "name": f.OriginalName, "size": f.Size,
		"mimeType": f.MimeType, "kind": f.Kind, "createdAt": f.CreatedAt,
	}
}

// withPadID extracts and validates ?id=... before calling the handler —
// equivalent to the requirePadId middleware in server/routes/pad.js.
func withPadID(next func(w http.ResponseWriter, r *http.Request, padID string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		padID := normalizePadID(r.URL.Query().Get("id"))
		if padID == "" {
			writeJSONError(w, http.StatusBadRequest, "invalid_pad_id")
			return
		}
		next(w, r, padID)
	}
}

func handlePadGet(cfg *Config, db *sql.DB) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, padID string) {
		pad, err := getOrCreatePad(db, padID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		hasPassword := pad.PasswordHash.Valid && pad.PasswordHash.String != ""
		unlocked := isPadUnlocked(cfg, r, padID, pad)
		if hasPassword && !unlocked {
			writeJSON(w, http.StatusOK, map[string]any{"id": padID, "hasPassword": true, "locked": true})
			return
		}
		files, err := listFiles(db, padID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		fj := make([]map[string]any, 0, len(files))
		for _, f := range files {
			fj = append(fj, fileToJSON(f))
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"id": padID, "hasPassword": hasPassword, "locked": false,
			"content": pad.Content, "version": pad.Version, "updatedAt": pad.UpdatedAt, "files": fj,
		})
	}
}

func handlePadPoll(db *sql.DB) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, padID string) {
		pad, err := getPad(db, padID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		version := int64(0)
		if pad != nil {
			version = pad.Version
		}
		writeJSON(w, http.StatusOK, map[string]int64{"version": version})
	}
}

type putContentBody struct {
	Content string `json:"content"`
}

func handlePadPut(cfg *Config, db *sql.DB, hub *wsHub) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, padID string) {
		if !csrfValid(r) {
			writeJSONError(w, http.StatusForbidden, "csrf_invalid")
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
		var body putContentBody
		if err := readJSONBody(r, 4*1024*1024, &body); err != nil {
			body.Content = ""
		}
		if len(body.Content) > cfg.MaxPadContentChars {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "content_too_large")
			return
		}
		updated, err := updateContent(db, padID, body.Content)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		hub.broadcastPadChanged(padID, map[string]any{"version": updated.Version})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": updated.Version})
	}
}

func handlePadDelete(cfg *Config, db *sql.DB, hub *wsHub) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, padID string) {
		if !csrfValid(r) {
			writeJSONError(w, http.StatusForbidden, "csrf_invalid")
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
		removed, err := clearPad(db, padID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		for _, f := range removed {
			deleteStoredFile(cfg, f.StoredName)
		}
		hub.broadcastPadChanged(padID, nil)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

type padPasswordBody struct {
	Password string `json:"password"`
}

func handlePadSetPassword(cfg *Config, db *sql.DB, hub *wsHub) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, padID string) {
		if !csrfValid(r) {
			writeJSONError(w, http.StatusForbidden, "csrf_invalid")
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
		var body padPasswordBody
		_ = readJSONBody(r, 4*1024, &body)
		if body.Password == "" {
			_ = setPadPassword(db, padID, nil)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "hasPassword": false})
			hub.broadcastPadChanged(padID, nil)
			return
		}
		if len(body.Password) < 4 || len(body.Password) > 200 {
			writeJSONError(w, http.StatusBadRequest, "invalid_password_length")
			return
		}
		hash, err := hashPadPassword(body.Password)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		if err := setPadPassword(db, padID, &hash); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		markPadUnlocked(cfg, w, r, padID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "hasPassword": true})
		// Broadcast only after the response (which carries the unlock cookie)
		// has been written — never before: the person who just set the
		// password already has a WebSocket connection open on this pad, and
		// if "changed" arrived first, the refresh() it triggers would still
		// use the old cookie and see itself as locked, right after setting
		// the password.
		hub.broadcastPadChanged(padID, nil)
	}
}

func handlePadUnlock(cfg *Config, db *sql.DB) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, padID string) {
		if !csrfValid(r) {
			writeJSONError(w, http.StatusForbidden, "csrf_invalid")
			return
		}
		pad, err := getOrCreatePad(db, padID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		if !pad.PasswordHash.Valid || pad.PasswordHash.String == "" {
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
		var body padPasswordBody
		_ = readJSONBody(r, 4*1024, &body)
		if !verifyPadPassword(body.Password, pad.PasswordHash.String) {
			// 403, not 401: the client treats any 401 as "site auth required"
			// and redirects to /login (see api() in app.js) — a wrong pad
			// password has nothing to do with that.
			writeJSONError(w, http.StatusForbidden, "invalid_password")
			return
		}
		markPadUnlocked(cfg, w, r, padID)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func registerPadRoutes(mux *http.ServeMux, cfg *Config, db *sql.DB, hub *wsHub, gate func(http.HandlerFunc) http.HandlerFunc) {
	mux.HandleFunc("GET /api/pad", gate(withPadID(handlePadGet(cfg, db))))
	mux.HandleFunc("GET /api/pad/poll", gate(withPadID(handlePadPoll(db))))
	mux.HandleFunc("PUT /api/pad", gate(padWriteLimiter.middleware(withPadID(handlePadPut(cfg, db, hub)))))
	mux.HandleFunc("DELETE /api/pad", gate(withPadID(handlePadDelete(cfg, db, hub))))
	mux.HandleFunc("POST /api/pad/password", gate(padPasswordLimiter.middleware(withPadID(handlePadSetPassword(cfg, db, hub)))))
	mux.HandleFunc("POST /api/pad/unlock", gate(padPasswordLimiter.middleware(withPadID(handlePadUnlock(cfg, db)))))
}
