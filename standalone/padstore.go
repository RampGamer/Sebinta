package main

import (
	"database/sql"
	"regexp"
	"strings"
	"time"
)

// Segmentos reservados: nunca podem ser o pad (colidem com rotas da app).
// Mesma lista que server/services/padStore.js.
var reservedTopSegments = map[string]bool{
	"api": true, "ws": true, "login": true, "logout": true, "health": true,
	"css": true, "js": true, "fonts": true, "vendor": true, "favicon.ico": true,
	"robots.txt": true, "uploads": true,
}

var padIDRe = regexp.MustCompile(`^[a-zA-Z0-9._~-]+(/[a-zA-Z0-9._~-]+)*$`)

// normalizePadId espelha padStore.js: normaliza um caminho de URL como
// identificador de pad, prevenindo path traversal e segmentos reservados.
func normalizePadID(raw string) string {
	p := strings.TrimSpace(raw)
	p = strings.Trim(p, "/")
	if p == "" || len(p) > 200 {
		return ""
	}
	if strings.Contains(p, "..") {
		return ""
	}
	if !padIDRe.MatchString(p) {
		return ""
	}
	first := strings.ToLower(strings.SplitN(p, "/", 2)[0])
	if reservedTopSegments[first] {
		return ""
	}
	return p
}

type Pad struct {
	ID           string
	Content      string
	PasswordHash sql.NullString
	Version      int64
	CreatedAt    int64
	UpdatedAt    int64
}

type File struct {
	ID           string
	PadID        string
	OriginalName string
	StoredName   string
	MimeType     string
	Size         int64
	Kind         string
	CreatedAt    int64
}

func nowMs() int64 { return time.Now().UnixMilli() }

func scanPad(row interface{ Scan(...any) error }) (*Pad, error) {
	var p Pad
	if err := row.Scan(&p.ID, &p.Content, &p.PasswordHash, &p.Version, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, err
	}
	return &p, nil
}

func getPad(db *sql.DB, padID string) (*Pad, error) {
	row := db.QueryRow(`SELECT id, content, password_hash, version, created_at, updated_at FROM pads WHERE id = ?`, padID)
	p, err := scanPad(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return p, err
}

func getOrCreatePad(db *sql.DB, padID string) (*Pad, error) {
	existing, err := getPad(db, padID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil
	}
	now := nowMs()
	if _, err := db.Exec(`INSERT INTO pads (id, content, version, created_at, updated_at) VALUES (?, '', 0, ?, ?)`, padID, now, now); err != nil {
		return nil, err
	}
	return getPad(db, padID)
}

func updateContent(db *sql.DB, padID, content string) (*Pad, error) {
	now := nowMs()
	if _, err := db.Exec(`UPDATE pads SET content = ?, version = version + 1, updated_at = ? WHERE id = ?`, content, now, padID); err != nil {
		return nil, err
	}
	return getPad(db, padID)
}

func clearPad(db *sql.DB, padID string) ([]*File, error) {
	now := nowMs()
	if _, err := db.Exec(`UPDATE pads SET content = '', version = version + 1, updated_at = ? WHERE id = ?`, now, padID); err != nil {
		return nil, err
	}
	files, err := listFiles(db, padID)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`DELETE FROM files WHERE pad_id = ?`, padID); err != nil {
		return nil, err
	}
	return files, nil
}

func setPadPassword(db *sql.DB, padID string, hash *string) error {
	_, err := db.Exec(`UPDATE pads SET password_hash = ? WHERE id = ?`, hash, padID)
	return err
}

func listFiles(db *sql.DB, padID string) ([]*File, error) {
	rows, err := db.Query(`SELECT id, pad_id, original_name, stored_name, mime_type, size, kind, created_at FROM files WHERE pad_id = ? ORDER BY created_at ASC`, padID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*File
	for rows.Next() {
		var f File
		if err := rows.Scan(&f.ID, &f.PadID, &f.OriginalName, &f.StoredName, &f.MimeType, &f.Size, &f.Kind, &f.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &f)
	}
	return out, rows.Err()
}

func getFile(db *sql.DB, padID, fileID string) (*File, error) {
	row := db.QueryRow(`SELECT id, pad_id, original_name, stored_name, mime_type, size, kind, created_at FROM files WHERE pad_id = ? AND id = ?`, padID, fileID)
	var f File
	err := row.Scan(&f.ID, &f.PadID, &f.OriginalName, &f.StoredName, &f.MimeType, &f.Size, &f.Kind, &f.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &f, err
}

func insertFile(db *sql.DB, f *File) error {
	if _, err := db.Exec(`INSERT INTO files (id, pad_id, original_name, stored_name, mime_type, size, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		f.ID, f.PadID, f.OriginalName, f.StoredName, f.MimeType, f.Size, f.Kind, f.CreatedAt); err != nil {
		return err
	}
	_, err := db.Exec(`UPDATE pads SET version = version + 1, updated_at = ? WHERE id = ?`, nowMs(), f.PadID)
	return err
}

func deleteFile(db *sql.DB, padID, fileID string) (*File, error) {
	f, err := getFile(db, padID, fileID)
	if err != nil || f == nil {
		return nil, err
	}
	if _, err := db.Exec(`DELETE FROM files WHERE pad_id = ? AND id = ?`, padID, fileID); err != nil {
		return nil, err
	}
	if _, err := db.Exec(`UPDATE pads SET version = version + 1, updated_at = ? WHERE id = ?`, nowMs(), padID); err != nil {
		return nil, err
	}
	return f, nil
}

func findExpiredFiles(db *sql.DB, ttlDays int) ([]*File, error) {
	cutoff := nowMs() - int64(ttlDays)*24*60*60*1000
	rows, err := db.Query(`SELECT id, pad_id, original_name, stored_name, mime_type, size, kind, created_at FROM files WHERE created_at < ?`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*File
	for rows.Next() {
		var f File
		if err := rows.Scan(&f.ID, &f.PadID, &f.OriginalName, &f.StoredName, &f.MimeType, &f.Size, &f.Kind, &f.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &f)
	}
	return out, rows.Err()
}
