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
	cfg := loadConfig()
	currentConfig = cfg

	logFile, err := setupLogging(cfg)
	if err != nil {
		log.Fatalf("não foi possível preparar o ficheiro de logs (%s): %v", cfg.LogPath, err)
	}
	defer logFile.Close()

	db := openDB(cfg)
	defer db.Close()

	hub := newWSHub()
	startCleanup(cfg, db, hub)

	webFS, err := fs.Sub(embeddedPublic, "public")
	if err != nil {
		log.Fatalf("não foi possível preparar os assets embutidos: %v", err)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.Handle("GET /css/", noDirListing(cacheOneHour(http.FileServer(http.FS(webFS)))))
	mux.Handle("GET /js/", noDirListing(cacheOneHour(http.FileServer(http.FS(webFS)))))

	mux.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) {
		serveEmbeddedFile(w, r, webFS, "login.html")
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

	// Qualquer outro caminho é um pad: serve a página do pad em SPA. A
	// validação do próprio nome do pad acontece do lado do cliente.
	mux.HandleFunc("GET /", siteAuthPageGate(cfg)(func(w http.ResponseWriter, r *http.Request) {
		serveEmbeddedFile(w, r, webFS, "pad.html")
	}))

	handler := securityHeaders(ensureCsrfMiddleware(cfg, accessLog(mux.ServeHTTP)))

	log.Printf("Filepad (standalone) a correr na porta %s", cfg.Port)
	log.Printf("Password do site: %s", boolLabel(siteAuthEnabled(cfg)))
	log.Printf("Logs também gravados em %s", cfg.LogPath)

	server := &http.Server{Addr: ":" + cfg.Port, Handler: handler}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	var tunnel *tunnelHandle
	if cfg.DisableTunnel {
		log.Println("DISABLE_TUNNEL definido — sem túnel Cloudflare, o servidor só fica acessível localmente.")
	} else {
		urlCh := make(chan string, 1)
		h, err := startTunnel(cfg, urlCh)
		if err != nil {
			log.Printf("Aviso: não foi possível arrancar o túnel Cloudflare embutido: %v", err)
			log.Println("O servidor continua a correr localmente. Define DISABLE_TUNNEL=true para não tentar de novo.")
		} else {
			tunnel = h
			go func() {
				select {
				case u := <-urlCh:
					log.Printf("Filepad disponível em: %s", u)
				case <-time.After(30 * time.Second):
					log.Println("O túnel Cloudflare ainda não respondeu com um URL — ver linhas [cloudflared] acima.")
				}
			}()
		}
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("A encerrar...")
	tunnel.stop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
}

func boolLabel(b bool) string {
	if b {
		return "ativa"
	}
	return "desativada"
}

// --- middlewares globais ---

func ensureCsrfMiddleware(cfg *Config, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ensureCsrfCookie(cfg, w, r)
		ctx := context.WithValue(r.Context(), csrfCtxKey, token)
		next(w, r.WithContext(ctx))
	}
}

// Log mínimo: método + caminho apenas. Nunca corpo, query de password, ou
// cookies (ver server/index.js — mesma política).
func accessLog(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/css") && !strings.HasPrefix(r.URL.Path, "/js") {
			log.Printf("%s %s", r.Method, r.URL.Path)
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
