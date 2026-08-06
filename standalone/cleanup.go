package main

import (
	"database/sql"
	"log"
	"os"
	"path/filepath"
	"time"
)

// Optional scheduled task (FILE_TTL_DAYS): deletes files older than N days,
// both from disk and the database. Port of server/services/cleanup.js.

const checkInterval = time.Hour

// sweepQuarantine: nothing should stay in the quarantine folder
// permanently — if the process dies mid-upload (between multer's initial
// write and the move to uploads/final/), the rest stays there. Sweeps
// quarantine and deletes anything older than 1h (never associated with
// any pad, always safe to delete).
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
	log.Printf("[cleanup] %d expired file(s) removed (TTL=%dd).", len(expired), cfg.FileTTLDays)
}

func startCleanup(cfg *Config, db *sql.DB, hub *wsHub) {
	sweepQuarantine(cfg)
	go func() {
		for range time.Tick(checkInterval) {
			sweepQuarantine(cfg)
		}
	}()

	if cfg.FileTTLDays <= 0 {
		log.Println("[cleanup] FILE_TTL_DAYS not set — automatic cleanup of old files disabled.")
		return
	}
	runCleanupOnce(cfg, db, hub)
	go func() {
		for range time.Tick(checkInterval) {
			runCleanupOnce(cfg, db, hub)
		}
	}()
	log.Printf("[cleanup] automatic cleanup enabled: files older than %d day(s) will be removed.", cfg.FileTTLDays)
}
