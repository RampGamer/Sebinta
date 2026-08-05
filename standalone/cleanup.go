package main

import (
	"database/sql"
	"log"
	"os"
	"path/filepath"
	"time"
)

// Tarefa agendada opcional (FILE_TTL_DAYS): apaga ficheiros mais antigos que
// N dias, tanto do disco como da base de dados. Porta de
// server/services/cleanup.js.

const checkInterval = time.Hour

// sweepQuarantine: nada deve ficar na pasta de quarentena de forma
// permanente — se o processo morrer a meio de um upload (entre o multer/
// gravação inicial e a mudança para uploads/final/), o resto fica lá. Varre
// a quarentena e apaga tudo com mais de 1h (nunca associado a nenhum pad, é
// sempre seguro apagar).
func sweepQuarantine(cfg *Config) {
	entries, err := os.ReadDir(cfg.QuarantineDir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-time.Hour)
	for _, e := range entries {
		if e.Name() == ".gitkeep" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(cfg.QuarantineDir, e.Name()))
		}
	}
}

func runCleanupOnce(cfg *Config, db *sql.DB, hub *wsHub) {
	if cfg.FileTTLDays <= 0 {
		return
	}
	expired, err := findExpiredFiles(db, cfg.FileTTLDays)
	if err != nil || len(expired) == 0 {
		return
	}
	affected := map[string]bool{}
	for _, f := range expired {
		removed, err := deleteFile(db, f.PadID, f.ID)
		if err != nil || removed == nil {
			continue
		}
		deleteStoredFile(cfg, removed.StoredName)
		affected[removed.PadID] = true
	}
	for padID := range affected {
		hub.broadcastPadChanged(padID, nil)
	}
	log.Printf("[cleanup] %d ficheiro(s) expirado(s) removido(s) (TTL=%dd).", len(expired), cfg.FileTTLDays)
}

func startCleanup(cfg *Config, db *sql.DB, hub *wsHub) {
	sweepQuarantine(cfg)
	go func() {
		for range time.Tick(checkInterval) {
			sweepQuarantine(cfg)
		}
	}()

	if cfg.FileTTLDays <= 0 {
		log.Println("[cleanup] FILE_TTL_DAYS não definido — limpeza automática de ficheiros antigos desativada.")
		return
	}
	runCleanupOnce(cfg, db, hub)
	go func() {
		for range time.Tick(checkInterval) {
			runCleanupOnce(cfg, db, hub)
		}
	}()
	log.Printf("[cleanup] limpeza automática ativa: ficheiros com mais de %d dia(s) serão removidos.", cfg.FileTTLDays)
}
