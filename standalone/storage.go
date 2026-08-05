package main

import (
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Nomes gerados sempre pelo servidor (UUID + extensão curta) — nunca a
// partir do nome original do ficheiro. Mesma validação que
// server/services/storage.js.
var safeStoredNameRe = regexp.MustCompile(`^[a-fA-F0-9-]{36}(\.[a-zA-Z0-9]{1,10})?$`)

func isSafeStoredName(name string) bool {
	return safeStoredNameRe.MatchString(name)
}

func finalPath(cfg *Config, storedName string) string {
	if !isSafeStoredName(storedName) {
		return ""
	}
	base, _ := filepath.Abs(cfg.FinalDir)
	resolved := filepath.Join(base, storedName)
	if !strings.HasPrefix(resolved, base+string(filepath.Separator)) {
		return ""
	}
	return resolved
}

func quarantinePath(cfg *Config, name string) string {
	base, _ := filepath.Abs(cfg.QuarantineDir)
	return filepath.Join(base, name)
}

func deleteStoredFile(cfg *Config, storedName string) {
	p := finalPath(cfg, storedName)
	if p == "" {
		return
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		log.Printf("falha ao apagar ficheiro do armazenamento: %v", err)
	}
}
