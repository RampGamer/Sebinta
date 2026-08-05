package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// loadDotEnv lê um ficheiro .env simples (KEY=VALUE por linha, '#' para
// comentários) sem depender de nenhuma biblioteca externa. Nunca substitui
// uma variável de ambiente já definida no processo — mesmo comportamento do
// pacote "dotenv" usado pelo servidor Node (server/config.js).
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.Index(line, "=")
		if idx == -1 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		val = strings.Trim(val, `"'`)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, val)
		}
	}
}

type Config struct {
	RootDir string
	Port    string

	DataDir       string
	DBPath        string
	UploadsDir    string
	QuarantineDir string
	FinalDir      string

	SitePassword string
	CookieSecret string
	CookieSecure bool

	MaxFileSizeBytes int64
	MaxFileSizeMB    int64
	FileTTLDays      int

	MaxPadContentChars int

	TrustProxy bool
}

func envInt(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return v
}

func envBool(name string, fallback bool) bool {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	return raw != "false"
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // sem entropia disponível — sem isto não há como assinar cookies em segurança
	}
	return hex.EncodeToString(b)
}

func loadConfig() *Config {
	rootDir, err := os.Getwd()
	if err != nil {
		rootDir = "."
	}
	loadDotEnv(filepath.Join(rootDir, ".env"))

	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(rootDir, "data")
	}
	uploadsDir := os.Getenv("UPLOADS_DIR")
	if uploadsDir == "" {
		uploadsDir = filepath.Join(rootDir, "uploads")
	}
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = filepath.Join(dataDir, "filepad.db")
	}

	cookieSecret := os.Getenv("COOKIE_SECRET")
	if cookieSecret == "" {
		cookieSecret = randomHex(32)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	maxFileSizeMB := int64(envInt("MAX_FILE_SIZE_MB", 500))

	return &Config{
		RootDir: rootDir,
		Port:    port,

		DataDir:       dataDir,
		DBPath:        dbPath,
		UploadsDir:    uploadsDir,
		QuarantineDir: filepath.Join(uploadsDir, "quarantine"),
		FinalDir:      filepath.Join(uploadsDir, "final"),

		SitePassword: os.Getenv("SITE_PASSWORD"),
		CookieSecret: cookieSecret,
		CookieSecure: envBool("COOKIE_SECURE", true),

		MaxFileSizeMB:    maxFileSizeMB,
		MaxFileSizeBytes: maxFileSizeMB * 1024 * 1024,
		FileTTLDays:      envInt("FILE_TTL_DAYS", 0),

		MaxPadContentChars: envInt("MAX_PAD_CONTENT_CHARS", 2_000_000),

		TrustProxy: envBool("TRUST_PROXY", true),
	}
}
