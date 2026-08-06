package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Near-real-time sync between devices with the same pad open — port of
// server/ws.js. One WebSocket per tab, grouped by pad ("room"); when the
// pad changes, every connected client gets notified and re-fetches the
// current state from the server.

type wsHub struct {
	mu    sync.Mutex
	rooms map[string]map[*websocket.Conn]bool
}

func newWSHub() *wsHub {
	return &wsHub{rooms: map[string]map[*websocket.Conn]bool{}}
}

func (h *wsHub) join(padID string, c *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[padID] == nil {
		h.rooms[padID] = map[*websocket.Conn]bool{}
	}
	h.rooms[padID][c] = true
}

func (h *wsHub) leave(padID string, c *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room, ok := h.rooms[padID]; ok {
		delete(room, c)
		if len(room) == 0 {
			delete(h.rooms, padID)
		}
	}
}

func (h *wsHub) broadcastPadChanged(padID string, extra map[string]any) {
	h.mu.Lock()
	room := h.rooms[padID]
	conns := make([]*websocket.Conn, 0, len(room))
	for c := range room {
		conns = append(conns, c)
	}
	h.mu.Unlock()
	if len(conns) == 0 {
		return
	}
	payload := map[string]any{"type": "changed"}
	for k, v := range extra {
		payload[k] = v
	}
	b, _ := json.Marshal(payload)
	for _, c := range conns {
		_ = c.WriteMessage(websocket.TextMessage, b)
	}
}

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// No Origin check: the real authorization happens via signed cookie in
	// isWSRequestAuthorized, just like in the Node server.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// isWSRequestAuthorized mirrors server/ws.js#isRequestAuthorized: reads the
// signed fp_site/fp_unlocked cookies directly from the upgrade request
// (the same mechanism the regular HTTP routes use).
func isWSRequestAuthorized(cfg *Config, db *sql.DB, r *http.Request, padID string) bool {
	if cfg.SitePassword != "" {
		c, err := r.Cookie(siteCookie)
		if err != nil {
			return false
		}
		val, ok := unsignValue(cfg.CookieSecret, c.Value)
		if !ok || val != "ok" {
			return false
		}
	}
	pad, err := getPad(db, padID)
	if err != nil {
		return false
	}
	if pad != nil && pad.PasswordHash.Valid && pad.PasswordHash.String != "" {
		if !getUnlockedSet(cfg, r)[padHash(padID)] {
			return false
		}
	}
	return true
}

func handleWS(cfg *Config, db *sql.DB, hub *wsHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		padID := normalizePadID(r.URL.Query().Get("pad"))
		if padID == "" {
			http.Error(w, "invalid pad", http.StatusBadRequest)
			return
		}
		if !isWSRequestAuthorized(cfg, db, r, padID) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		conn, err := wsUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		hub.join(padID, conn)

		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			return nil
		})

		done := make(chan struct{})
		go func() {
			defer close(done)
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
			}
		}()

		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				hub.leave(padID, conn)
				conn.Close()
				return
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					hub.leave(padID, conn)
					conn.Close()
					return
				}
			}
		}
	}
}
