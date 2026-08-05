package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type ctxKey string

const csrfCtxKey ctxKey = "csrfToken"

func csrfTokenFromContext(r *http.Request) string {
	if v, ok := r.Context().Value(csrfCtxKey).(string); ok {
		return v
	}
	return ""
}

const (
	siteCookie     = "fp_site"
	csrfCookie     = "fp_csrf"
	unlockedCookie = "fp_unlocked"
)

// --- cookies assinados (HMAC-SHA256, formato próprio — não precisa de ser
// compatível com o servidor Node, cada deployment tem a sua própria sessão) ---

func signValue(secret, value string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(value))
	return value + "." + hex.EncodeToString(mac.Sum(nil))
}

func unsignValue(secret, signed string) (string, bool) {
	idx := len(signed) - 64 - 1 // 64 hex chars de SHA-256 + '.'
	if idx <= 0 || signed[idx] != '.' {
		return "", false
	}
	value, sig := signed[:idx], signed[idx+1:]
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(value))
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(sig), []byte(expected)) {
		return "", false
	}
	return value, true
}

func cookieBase(cfg *Config, name, value string, maxAge time.Duration, httpOnly bool) *http.Cookie {
	return &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: httpOnly,
		Secure:   cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(maxAge.Seconds()),
	}
}

// safeCompare: comparação em tempo constante para evitar timing attacks na
// password do site. Espelha server/auth.js#safeCompare.
func safeCompare(a, b string) bool {
	ba, bb := []byte(a), []byte(b)
	if len(ba) != len(bb) {
		subtle.ConstantTimeCompare(ba, ba) // mantém o custo previsível mesmo com tamanhos diferentes
		return false
	}
	return subtle.ConstantTimeCompare(ba, bb) == 1
}

func siteAuthEnabled(cfg *Config) bool { return cfg.SitePassword != "" }

func isSiteAuthed(cfg *Config, r *http.Request) bool {
	if !siteAuthEnabled(cfg) {
		return true
	}
	c, err := r.Cookie(siteCookie)
	if err != nil {
		return false
	}
	val, ok := unsignValue(cfg.CookieSecret, c.Value)
	return ok && val == "ok"
}

func setSiteAuthCookie(cfg *Config, w http.ResponseWriter) {
	http.SetCookie(w, cookieBase(cfg, siteCookie, signValue(cfg.CookieSecret, "ok"), 30*24*time.Hour, true))
}

func clearSiteAuthCookie(cfg *Config, w http.ResponseWriter) {
	c := cookieBase(cfg, siteCookie, "", -1, true)
	http.SetCookie(w, c)
}

// --- CSRF (double-submit cookie, mesmo padrão que server/auth.js) ---

func ensureCsrfCookie(cfg *Config, w http.ResponseWriter, r *http.Request) string {
	if c, err := r.Cookie(csrfCookie); err == nil && c.Value != "" {
		return c.Value
	}
	token := randomHex(32)
	http.SetCookie(w, cookieBase(cfg, csrfCookie, token, 30*24*time.Hour, false))
	return token
}

func csrfValid(r *http.Request) bool {
	c, err := r.Cookie(csrfCookie)
	if err != nil || c.Value == "" {
		return false
	}
	header := r.Header.Get("X-CSRF-Token")
	if header == "" {
		return false
	}
	return safeCompare(c.Value, header)
}

// --- password por pad ---

func hashPadPassword(password string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(b), err
}

func verifyPadPassword(password, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func padHash(padID string) string {
	sum := sha256.Sum256([]byte(padID))
	return hex.EncodeToString(sum[:])[:16]
}

func getUnlockedSet(cfg *Config, r *http.Request) map[string]bool {
	out := map[string]bool{}
	c, err := r.Cookie(unlockedCookie)
	if err != nil {
		return out
	}
	raw, ok := unsignValue(cfg.CookieSecret, c.Value)
	if !ok {
		return out
	}
	jsonBytes, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return out
	}
	var arr []string
	if err := json.Unmarshal(jsonBytes, &arr); err != nil {
		return out
	}
	for _, h := range arr {
		out[h] = true
	}
	return out
}

func isPadUnlocked(cfg *Config, r *http.Request, padID string, pad *Pad) bool {
	if pad == nil || !pad.PasswordHash.Valid || pad.PasswordHash.String == "" {
		return true
	}
	return getUnlockedSet(cfg, r)[padHash(padID)]
}

func markPadUnlocked(cfg *Config, w http.ResponseWriter, r *http.Request, padID string) {
	set := getUnlockedSet(cfg, r)
	set[padHash(padID)] = true
	arr := make([]string, 0, len(set))
	for h := range set {
		arr = append(arr, h)
	}
	// Limite defensivo para o cookie não crescer sem controlo (mesmo que
	// server/auth.js — mantém só os últimos 200).
	if len(arr) > 200 {
		arr = arr[len(arr)-200:]
	}
	b, _ := json.Marshal(arr)
	// O valor assinado tem de ser seguro para cookie-octet (RFC 6265): JSON
	// cru contém aspas, que o sanitizador de cookies do Go remove em
	// silêncio, corrompendo o valor. base64url evita isso.
	encoded := base64.RawURLEncoding.EncodeToString(b)
	http.SetCookie(w, cookieBase(cfg, unlockedCookie, signValue(cfg.CookieSecret, encoded), 7*24*time.Hour, true))
}
