package main

import (
	"encoding/json"
	"net/http"
)

// currentConfig é definido uma vez em main() — evita ter de passar *Config
// através de todas as assinaturas de middleware (o próprio processo só
// tem uma configuração, carregada uma vez no arranque).
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
