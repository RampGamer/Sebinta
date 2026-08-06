package main

import (
	"bytes"
	"path/filepath"
	"strings"
)

// Detects a file's real type from its magic bytes, instead of trusting the
// extension or the Content-Type sent by the browser. 1:1 port of
// server/services/fileType.js.

type Sniffed struct {
	Mime   string
	Kind   string // image | video | audio | pdf | ooxml | legacy-office | zip | other
	Ext    string
	Family string
}

var extMimeFallback = map[string]string{
	".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
	".json": "application/json", ".xml": "application/xml", ".svg": "image/svg+xml",
	".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".odt":  "application/vnd.oasis.opendocument.text",
	".ods":  "application/vnd.oasis.opendocument.spreadsheet",
	".odp":  "application/vnd.oasis.opendocument.presentation",
}

var ooxmlExt = map[string]bool{".docx": true, ".xlsx": true, ".pptx": true, ".odt": true, ".ods": true, ".odp": true}

func matchesAt(buf []byte, offset int, sig []byte) bool {
	if len(buf) < offset+len(sig) {
		return false
	}
	return bytes.Equal(buf[offset:offset+len(sig)], sig)
}

func asciiAt(buf []byte, offset, length int) string {
	if len(buf) < offset+length {
		return ""
	}
	return string(buf[offset : offset+length])
}

func sniff(buf []byte, originalName string) Sniffed {
	ext := strings.ToLower(filepath.Ext(originalName))

	switch {
	case matchesAt(buf, 0, []byte{0xff, 0xd8, 0xff}):
		return Sniffed{"image/jpeg", "image", ".jpg", "image"}
	case matchesAt(buf, 0, []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}):
		return Sniffed{"image/png", "image", ".png", "image"}
	case matchesAt(buf, 0, []byte{0x47, 0x49, 0x46, 0x38}) && len(buf) > 5 && (buf[4] == 0x37 || buf[4] == 0x39) && buf[5] == 0x61:
		return Sniffed{"image/gif", "image", ".gif", "image"}
	case asciiAt(buf, 0, 4) == "RIFF" && asciiAt(buf, 8, 4) == "WEBP":
		return Sniffed{"image/webp", "image", ".webp", "image"}
	case matchesAt(buf, 0, []byte{0x42, 0x4d}):
		return Sniffed{"image/bmp", "image", ".bmp", "image"}
	}

	head := strings.ToLower(strings.TrimSpace(string(headBytes(buf, 512))))
	if ext == ".svg" && (strings.HasPrefix(head, "<?xml") || strings.HasPrefix(head, "<svg")) {
		return Sniffed{"image/svg+xml", "other", ".svg", "svg"}
	}

	if asciiAt(buf, 0, 5) == "%PDF-" {
		return Sniffed{"application/pdf", "pdf", ".pdf", "pdf"}
	}

	if asciiAt(buf, 4, 4) == "ftyp" {
		e := ".mp4"
		if ext == ".mov" {
			e = ".mov"
		}
		return Sniffed{"video/mp4", "video", e, "video"}
	}
	if matchesAt(buf, 0, []byte{0x1a, 0x45, 0xdf, 0xa3}) {
		if ext == ".mkv" {
			return Sniffed{"video/x-matroska", "video", ".mkv", "video"}
		}
		return Sniffed{"video/webm", "video", ".webm", "video"}
	}
	if asciiAt(buf, 0, 4) == "RIFF" && asciiAt(buf, 8, 4) == "AVI " {
		return Sniffed{"video/x-msvideo", "video", ".avi", "video"}
	}

	if asciiAt(buf, 0, 4) == "RIFF" && asciiAt(buf, 8, 4) == "WAVE" {
		return Sniffed{"audio/wav", "audio", ".wav", "audio"}
	}
	if matchesAt(buf, 0, []byte{0x49, 0x44, 0x33}) || matchesAt(buf, 0, []byte{0xff, 0xfb}) || matchesAt(buf, 0, []byte{0xff, 0xf3}) || matchesAt(buf, 0, []byte{0xff, 0xf2}) {
		return Sniffed{"audio/mpeg", "audio", ".mp3", "audio"}
	}
	if asciiAt(buf, 0, 4) == "OggS" {
		return Sniffed{"audio/ogg", "audio", ".ogg", "audio"}
	}
	if asciiAt(buf, 0, 4) == "fLaC" {
		return Sniffed{"audio/flac", "audio", ".flac", "audio"}
	}

	if matchesAt(buf, 0, []byte{0x50, 0x4b, 0x03, 0x04}) || matchesAt(buf, 0, []byte{0x50, 0x4b, 0x05, 0x06}) {
		if ooxmlExt[ext] {
			return Sniffed{extMimeFallback[ext], "ooxml", ext, "zip"}
		}
		return Sniffed{"application/zip", "zip", ".zip", "zip"}
	}

	if matchesAt(buf, 0, []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}) {
		mime, ok := extMimeFallback[ext]
		if !ok {
			mime = "application/x-ole-storage"
		}
		e := ext
		if e == "" {
			e = ".doc"
		}
		return Sniffed{mime, "legacy-office", e, "ole"}
	}

	mime, ok := extMimeFallback[ext]
	if !ok {
		mime = "application/octet-stream"
	}
	return Sniffed{mime, "other", ext, "other"}
}

func headBytes(buf []byte, n int) []byte {
	if len(buf) < n {
		return buf
	}
	return buf[:n]
}

func uiKind(s Sniffed) string {
	switch s.Kind {
	case "image":
		return "image"
	case "video":
		return "video"
	default:
		return "other"
	}
}
