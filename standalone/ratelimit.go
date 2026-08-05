package main

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Limitador por IP em memória, janela fixa — mesmo algoritmo e mesmos
// limites que server/middleware/rateLimit.js (express-rate-limit).
type RateLimiter struct {
	window  time.Duration
	limit   int
	message string

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	windowStart time.Time
	count       int
}

func newRateLimiter(window time.Duration, limit int, message string) *RateLimiter {
	return &RateLimiter{window: window, limit: limit, message: message, buckets: map[string]*bucket{}}
}

// allow regista um pedido para o IP dado; devolve false se o limite da
// janela atual já foi excedido.
func (rl *RateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	b, ok := rl.buckets[ip]
	if !ok || now.Sub(b.windowStart) > rl.window {
		rl.buckets[ip] = &bucket{windowStart: now, count: 1}
		return true
	}
	if b.count >= rl.limit {
		return false
	}
	b.count++
	return true
}

func (rl *RateLimiter) middleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r, currentConfig)
		if !rl.allow(ip) {
			writeJSONError(w, http.StatusTooManyRequests, rl.message)
			return
		}
		next(w, r)
	}
}

var (
	loginLimiter       = newRateLimiter(15*time.Minute, 10, "too_many_attempts")
	padPasswordLimiter = newRateLimiter(10*time.Minute, 15, "too_many_attempts")
	uploadLimiter      = newRateLimiter(5*time.Minute, 60, "too_many_uploads")
	padWriteLimiter    = newRateLimiter(1*time.Minute, 120, "too_many_requests")
)

// clientIP replica o comportamento do "trust proxy" do Express: com
// TRUST_PROXY ativo (omissão), usa o primeiro IP de X-Forwarded-For; caso
// contrário usa sempre o IP da ligação TCP direta.
func clientIP(r *http.Request, cfg *Config) string {
	if cfg != nil && cfg.TrustProxy {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			parts := strings.Split(fwd, ",")
			return strings.TrimSpace(parts[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
