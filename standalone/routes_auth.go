package main

import (
	"database/sql"
	"net/http"
)

type loginBody struct {
	Password string `json:"password"`
}

func handleAuthStatus(cfg *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"siteAuthEnabled": siteAuthEnabled(cfg),
			"siteAuthed":      isSiteAuthed(cfg, r),
			"csrfToken":       csrfTokenFromContext(r),
		})
	}
}

// Nota: a password nunca é escrita em logs (ver o log de acesso em main.go,
// que regista apenas método+caminho, nunca o corpo).
func handleLogin(cfg *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !csrfValid(r) {
			writeJSONError(w, http.StatusForbidden, "csrf_invalid")
			return
		}
		if !siteAuthEnabled(cfg) {
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
		var body loginBody
		_ = readJSONBody(r, 2*1024, &body)
		if body.Password == "" || !safeCompare(body.Password, cfg.SitePassword) {
			writeJSONError(w, http.StatusUnauthorized, "invalid_password")
			return
		}
		setSiteAuthCookie(cfg, w)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func handleLogout(cfg *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !csrfValid(r) {
			writeJSONError(w, http.StatusForbidden, "csrf_invalid")
			return
		}
		clearSiteAuthCookie(cfg, w)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func registerAuthRoutes(mux *http.ServeMux, cfg *Config, _ *sql.DB) {
	mux.HandleFunc("GET /api/auth/status", handleAuthStatus(cfg))
	mux.HandleFunc("POST /api/auth/login", loginLimiter.middleware(handleLogin(cfg)))
	mux.HandleFunc("POST /api/auth/logout", handleLogout(cfg))
}
