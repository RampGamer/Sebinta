package main

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// In-memory per-IP limiter, fixed window — same algorithm and same limits
// as server/middleware/rateLimit.js (express-rate-limit).
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

// allow records a request for the given IP; returns false if the current
// window's limit has already been exceeded.
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

// retryAfter reports how many seconds are left in ip's current window — 0 if
// it isn't in a tracked window at all. Lets the client show a real countdown
// instead of a generic "wait a bit".
func (rl *RateLimiter) retryAfter(ip string) int {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	b, ok := rl.buckets[ip]
	if !ok {
		return 0
	}
	remaining := rl.window - time.Since(b.windowStart)
	if remaining <= 0 {
		return 0
	}
	secs := int(remaining.Round(time.Second) / time.Second)
	if secs < 1 {
		secs = 1
	}
	return secs
}

func (rl *RateLimiter) middleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r, currentConfig)
		if !rl.allow(ip) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": rl.message, "retryAfterSeconds": rl.retryAfter(ip)})
			return
		}
		next(w, r)
	}
}

var (
	loginLimiter       = newRateLimiter(15*time.Minute, 10, "too_many_attempts")
	// The blanket per-IP guard against abuse — brute-forcing a pad's
	// password specifically is padUnlockAttemptLimiter's job below, so this
	// one can afford to be generous rather than tripping on normal use
	// (checking/changing a password a few times while setting up a pad).
	padPasswordLimiter = newRateLimiter(10*time.Minute, 60, "too_many_attempts")
	uploadLimiter      = newRateLimiter(5*time.Minute, 60, "too_many_uploads")
	padWriteLimiter    = newRateLimiter(1*time.Minute, 120, "too_many_requests")

	// Tighter, pad-scoped guard against password guessing: 5 wrong guesses
	// against the same pad locks that (IP, pad) pair out for 30s. Keyed by
	// IP+pad rather than pad alone, so one attacker can't lock everyone else
	// out of unlocking a shared pad just by failing on purpose.
	padUnlockAttemptLimiter = newFailedAttemptLimiter(5, 30*time.Second)

	// Knowing a pad's name is already enough to read/edit/delete it (that's
	// this app's whole no-accounts model), but *protecting* a still-open
	// pad shouldn't be that cheap — there's nothing else stopping a script
	// from working through a wordlist of common pad names and password-
	// locking every one it finds, denying real users access to pads they
	// were already using. Caps how many previously-unprotected pads one IP
	// can newly protect per hour; changing/removing a password you already
	// hold doesn't count, so this never affects normal use of your own pads.
	newPadLockLimiter = newDistinctSetLimiter(1*time.Hour, 20)
)

// FailedAttemptLimiter locks a key out for a fixed duration once it racks up
// enough consecutive failures — unlike RateLimiter's fixed window, a single
// success resets the count, so legitimate retries after a typo don't count
// against the limit.
type FailedAttemptLimiter struct {
	threshold int
	lockout   time.Duration

	mu    sync.Mutex
	state map[string]*failState
}

type failState struct {
	failures    int
	lockedUntil time.Time
}

func newFailedAttemptLimiter(threshold int, lockout time.Duration) *FailedAttemptLimiter {
	return &FailedAttemptLimiter{threshold: threshold, lockout: lockout, state: map[string]*failState{}}
}

// blockedFor returns how much longer key stays locked out, or 0 if it isn't
// (or never has been) — lets the caller tell the client exactly when it can
// retry, instead of a generic "wait a bit".
func (l *FailedAttemptLimiter) blockedFor(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	s, ok := l.state[key]
	if !ok {
		return 0
	}
	remaining := time.Until(s.lockedUntil)
	if remaining < 0 {
		return 0
	}
	return remaining
}

// recordFailure counts a wrong attempt, locking the key out once the
// threshold is reached.
func (l *FailedAttemptLimiter) recordFailure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	s, ok := l.state[key]
	if !ok {
		s = &failState{}
		l.state[key] = s
	}
	s.failures++
	if s.failures >= l.threshold {
		s.lockedUntil = time.Now().Add(l.lockout)
		s.failures = 0
	}
}

// recordSuccess clears any accumulated failures for key.
func (l *FailedAttemptLimiter) recordSuccess(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.state, key)
}

// DistinctSetLimiter caps how many *distinct* items a key has touched within
// a fixed window — unlike RateLimiter, which counts requests regardless of
// what they're for, this counts unique items, so repeating the same item
// (e.g. re-saving a password on a pad you already just protected) never
// counts against the limit.
type DistinctSetLimiter struct {
	window time.Duration
	limit  int

	mu   sync.Mutex
	sets map[string]*itemSet
}

type itemSet struct {
	windowStart time.Time
	items       map[string]bool
}

func newDistinctSetLimiter(window time.Duration, limit int) *DistinctSetLimiter {
	return &DistinctSetLimiter{window: window, limit: limit, sets: map[string]*itemSet{}}
}

// allow reports whether key may touch item — true if item was already
// counted this window, or if the window has room for one more distinct
// item. Records item as counted either way (unless the limit was hit).
func (l *DistinctSetLimiter) allow(key, item string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	s, ok := l.sets[key]
	if !ok || now.Sub(s.windowStart) > l.window {
		s = &itemSet{windowStart: now, items: map[string]bool{}}
		l.sets[key] = s
	}
	if s.items[item] {
		return true
	}
	if len(s.items) >= l.limit {
		return false
	}
	s.items[item] = true
	return true
}

// retryAfter reports how many seconds are left in key's current window.
func (l *DistinctSetLimiter) retryAfter(key string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	s, ok := l.sets[key]
	if !ok {
		return 0
	}
	remaining := l.window - time.Since(s.windowStart)
	if remaining <= 0 {
		return 0
	}
	secs := int(remaining.Round(time.Second) / time.Second)
	if secs < 1 {
		secs = 1
	}
	return secs
}

// clientIP replicates Express's "trust proxy" behavior: with TRUST_PROXY
// enabled (the default), uses the first IP in X-Forwarded-For; otherwise
// always uses the direct TCP connection's IP.
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
