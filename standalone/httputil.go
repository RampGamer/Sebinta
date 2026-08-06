package main

import (
	"encoding/json"
	"net/http"
)

// currentConfig is set once in main() — avoids passing *Config through
// every middleware signature (the process itself only has one
// configuration, loaded once at startup).
var currentConfig *Config

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeJSONError(w http.ResponseWriter, status int, errCode string) {
	writeJSON(w, status, map[string]string{"error": errCode})
}

func readJSONBody(r *http.Request, maxBytes int64, dst any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	return dec.Decode(dst)
}
