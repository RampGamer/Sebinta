package main

import "net/http"

// Restrictive CSP — same directives as server/middleware/security.js
// (no external CDNs: the vendor assets don't exist anymore, everything
// left is local). Plus the hardening headers helmet applied by default on
// the Node side.
const csp = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' blob: data:; " +
	"media-src 'self' blob:; " +
	"connect-src 'self' ws: wss: https://api.github.com; " + // landing downloads: reads releases/latest
	"font-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'none'; " +
	"form-action 'self'; " +
	"frame-ancestors 'none'; " +
	"worker-src 'self' blob:; " +
	"upgrade-insecure-requests"

func securityHeaders(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("X-XSS-Protection", "0")
		h.Set("X-Permitted-Cross-Domain-Policies", "none")
		h.Set("Strict-Transport-Security", "max-age=15552000; includeSubDomains")
		next(w, r)
	}
}
