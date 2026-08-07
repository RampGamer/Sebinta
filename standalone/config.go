package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func printUsage() {
	fmt.Fprint(os.Stderr, `sebinta-server — single-binary Sebinta server: real-time text pads and
file sharing, with a public HTTPS URL via an embedded Cloudflare tunnel
(no separate install, no reverse proxy to set up).

Usage:
  sebinta-server [flags]

Flags:
  -port PORT
        TCP port to listen on (overrides $PORT and .env; default 3000)
  -tunnel-token TOKEN
        Cloudflare named-tunnel token for a fixed domain, instead of a
        random Quick Tunnel URL (overrides $TUNNEL_TOKEN and .env)
  -local
        Don't start the embedded Cloudflare tunnel — same as
        DISABLE_TUNNEL=true, just shorter to type
  -h, -help
        Show this help

Examples:
  sebinta-server                              Quick Tunnel: random *.trycloudflare.com URL, printed on startup
  sebinta-server -port 8080                   Listen on a different port
  sebinta-server -local                       Local access only, no tunnel
  sebinta-server -tunnel-token eyJhIjoi...    Fixed domain, via a Cloudflare named tunnel

Everything else — site password, upload size limit, cookie settings,
file TTL, and more — is set via environment variables or a .env file
next to the binary (same variables as the Docker image). Full list in
standalone/README.md.
`)
}

// loadDotEnv reads a simple .env file (KEY=VALUE per line, '#' for
// comments) with no external library dependency. Never overrides an
// environment variable already set in the process — same behavior as the
// "dotenv" package used by the Node server (server/config.js).
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
	LogPath       string

	DisableTunnel bool
	TunnelToken   string

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
		panic(err) // no entropy available — without this there's no secure way to sign cookies
	}
	return hex.EncodeToString(b)
}

func loadConfig() *Config {
	portFlag := flag.String("port", "", "TCP port to listen on (overrides $PORT and .env; default 3000)")
	tunnelTokenFlag := flag.String("tunnel-token", "", "Cloudflare named-tunnel token for a fixed domain (overrides $TUNNEL_TOKEN and .env)")
	localFlag := flag.Bool("local", false, "Don't start the embedded Cloudflare tunnel — same as DISABLE_TUNNEL=true, just shorter to type")
	flag.Usage = printUsage
	flag.Parse()

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
		dbPath = filepath.Join(dataDir, "sebinta.db")
	}

	cookieSecret := os.Getenv("COOKIE_SECRET")
	if cookieSecret == "" {
		cookieSecret = randomHex(32)
	}

	logPath := os.Getenv("LOG_FILE")
	if logPath == "" {
		logPath = filepath.Join(dataDir, "sebinta.log")
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	if *portFlag != "" {
		port = *portFlag // --port beats $PORT/.env — explicit command-line intent should win
	}

	tunnelToken := os.Getenv("TUNNEL_TOKEN")
	if *tunnelTokenFlag != "" {
		tunnelToken = *tunnelTokenFlag // --tunnel-token beats $TUNNEL_TOKEN/.env, same reasoning as --port
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
		LogPath:       logPath,

		DisableTunnel: envBool("DISABLE_TUNNEL", false) || *localFlag,
		TunnelToken:   tunnelToken,

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
