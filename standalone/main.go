package main

import (
	"context"
	"embed"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

//go:embed public
var embeddedPublic embed.FS

func main() {
	enableANSI()

	cfg := loadConfig()
	currentConfig = cfg

	logFile, err := setupLogging(cfg)
	if err != nil {
		log.Fatalf("could not prepare the log file (%s): %v", cfg.LogPath, err)
	}
	defer logFile.Close()

	db := openDB(cfg)
	defer db.Close()

	hub := newWSHub()
	startCleanup(cfg, db, hub)

	webFS, err := fs.Sub(embeddedPublic, "public")
	if err != nil {
		log.Fatalf("could not prepare the embedded assets: %v", err)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.Handle("GET /css/", noDirListing(cacheOneHour(http.FileServer(http.FS(webFS)))))
	mux.Handle("GET /js/", noDirListing(cacheOneHour(http.FileServer(http.FS(webFS)))))
	mux.Handle("GET /fonts/", noDirListing(cacheOneHour(http.FileServer(http.FS(webFS)))))

	mux.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) {
		serveEmbeddedFile(w, r, webFS, "login.html")
	})

	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		b, err := fs.ReadFile(webFS, "favicon.ico")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/x-icon")
		w.Write(b)
	})

	registerAuthRoutes(mux, cfg, db)
	registerPadRoutes(mux, cfg, db, hub, siteAuthAPIGate(cfg))
	registerFileRoutes(mux, cfg, db, hub, siteAuthAPIGate(cfg))

	apiNotFound := func(w http.ResponseWriter, r *http.Request) {
		writeJSONError(w, http.StatusNotFound, "not_found")
	}
	for _, method := range []string{"GET", "POST", "PUT", "DELETE", "PATCH"} {
		mux.HandleFunc(method+" /api/", apiNotFound)
	}

	mux.HandleFunc("GET /ws", handleWS(cfg, db, hub))

	// Any other path is a pad: serve the pad page as an SPA. Validating the
	// pad name itself happens client-side.
	mux.HandleFunc("GET /", siteAuthPageGate(cfg)(func(w http.ResponseWriter, r *http.Request) {
		serveEmbeddedFile(w, r, webFS, "pad.html")
	}))

	handler := securityHeaders(ensureCsrfMiddleware(cfg, accessLog(mux.ServeHTTP)))

	log.Printf("Sebinta (standalone) running on port %s", cfg.Port)
	log.Printf("Site password: %s", boolLabel(siteAuthEnabled(cfg)))
	log.Printf("Logs also written to %s", cfg.LogPath)

	server := &http.Server{Addr: ":" + cfg.Port, Handler: handler}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	var tunnel *tunnelHandle
	if cfg.DisableTunnel {
		log.Println("DISABLE_TUNNEL set — no Cloudflare tunnel, the server is only reachable locally.")
	} else {
		urlCh := make(chan string, 1)
		h, err := startTunnel(cfg, urlCh)
		if err != nil {
			log.Printf("Warning: could not start the embedded Cloudflare tunnel: %v", err)
			log.Println("The server keeps running locally. Set DISABLE_TUNNEL=true to stop retrying.")
		} else {
			tunnel = h
			go func() {
				select {
				case u := <-urlCh:
					printHighlight("Sebinta available at: %s", u)
				case <-time.After(30 * time.Second):
					log.Println("The Cloudflare tunnel hasn't responded with a URL yet — see the [cloudflared] lines above.")
				}
			}()
		}
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("Shutting down...")
	tunnel.stop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
}

func boolLabel(b bool) string {
	if b {
		return "enabled"
	}
	return "disabled"
}

// --- middlewares globais ---

func ensureCsrfMiddleware(cfg *Config, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ensureCsrfCookie(cfg, w, r)
		ctx := context.WithValue(r.Context(), csrfCtxKey, token)
		next(w, r.WithContext(ctx))
	}
}

// Logs client IP + method + path (never the body, password query strings,
// or cookies — the path alone doesn't include `?id=...`, see the matching
// note in server/index.js). The IP is the same one we use for rate
// limiting (clientIP, in ratelimit.go), so it respects TRUST_PROXY.
func accessLog(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/css") && !strings.HasPrefix(r.URL.Path, "/js") {
			log.Printf("%s %s %s", clientIP(r, currentConfig), r.Method, r.URL.Path)
		}
		next(w, r)
	}
}

func siteAuthAPIGate(cfg *Config) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !isSiteAuthed(cfg, r) {
				writeJSONError(w, http.StatusUnauthorized, "site_auth_required")
				return
			}
			next(w, r)
		}
	}
}

func siteAuthPageGate(cfg *Config) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if isSiteAuthed(cfg, r) {
				next(w, r)
				return
			}
			http.Redirect(w, r, "/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusFound)
		}
	}
}

func noDirListing(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func cacheOneHour(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=3600")
		next.ServeHTTP(w, r)
	})
}

func serveEmbeddedFile(w http.ResponseWriter, r *http.Request, webFS fs.FS, name string) {
	b, err := fs.ReadFile(webFS, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(b)
}
