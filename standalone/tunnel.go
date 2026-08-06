package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"
)

// The official cloudflared binary is embedded (see tunnel_<os>_<arch>.go,
// one per supported platform — only the one matching each build's target
// ends up in the final binary). cloudflared can't be embedded as a Go
// library: its entry point is package main (can't be imported) and its
// internals (supervisor, orchestration, ...) aren't a stable public API —
// the realistic path is running the same official binary, just without
// requiring the user to install it separately.

var trycloudflareRe = regexp.MustCompile(`https://[a-zA-Z0-9-]+\.trycloudflare\.com`)

// extractEmbeddedCloudflared writes the embedded binary to a temporary
// executable file and returns its path.
func extractEmbeddedCloudflared() (string, error) {
	dir, err := os.MkdirTemp("", "sebinta-cloudflared-")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "cloudflared"+embeddedCloudflaredExeSuffix)
	if err := os.WriteFile(path, embeddedCloudflared, 0o700); err != nil {
		return "", err
	}
	return path, nil
}

// tunnelHandle bundles the cloudflared process with the temp folder its
// embedded binary was extracted to, so the caller can stop and clean up
// everything synchronously on shutdown (can't rely on the reader goroutine
// alone for that — the process can exit before it runs).
type tunnelHandle struct {
	cmd     *exec.Cmd
	tempDir string
}

func (h *tunnelHandle) stop() {
	if h == nil {
		return
	}
	if h.cmd != nil && h.cmd.Process != nil {
		_ = h.cmd.Process.Kill()
		_ = h.cmd.Wait()
	}
	if h.tempDir != "" {
		os.RemoveAll(h.tempDir)
	}
}

// startTunnel starts the embedded cloudflared (Quick Tunnel by default, or a
// named tunnel if TUNNEL_TOKEN is set — the same variable docker-compose.yml
// uses). Each line of its output is forwarded to the app's logger (prefix
// "[cloudflared]"); when a *.trycloudflare.com URL shows up, it's sent to
// urlCh.
func startTunnel(cfg *Config, urlCh chan<- string) (*tunnelHandle, error) {
	binPath, err := extractEmbeddedCloudflared()
	if err != nil {
		return nil, fmt.Errorf("could not prepare the embedded cloudflared: %w", err)
	}
	tempDir := filepath.Dir(binPath)

	var args []string
	if cfg.TunnelToken != "" {
		log.Println("[cloudflared] TUNNEL_TOKEN set — connecting named tunnel.")
		args = []string{"tunnel", "run"}
	} else {
		log.Println("[cloudflared] requesting a Quick Tunnel (no Cloudflare account)...")
		args = []string{"tunnel", "--url", "http://localhost:" + cfg.Port}
	}

	cmd := exec.Command(binPath, args...)
	if cfg.TunnelToken != "" {
		cmd.Env = append(os.Environ(), "TUNNEL_TOKEN="+cfg.TunnelToken)
	}
	// cloudflared writes the interesting logs (including the Quick Tunnel
	// URL) to stderr — we merge both into the same pipe so we never miss a
	// line, and to avoid juggling two readers.
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw

	if err := cmd.Start(); err != nil {
		os.RemoveAll(tempDir)
		return nil, fmt.Errorf("could not start cloudflared: %w", err)
	}

	// Mirrors the process's output into the read pipe; closing the pipe when
	// the process exits is what makes the scanner below exit its loop.
	go func() {
		_ = cmd.Wait()
		pw.Close()
	}()

	go func() {
		scanner := bufio.NewScanner(pr)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			log.Printf("[cloudflared] %s", line)
			if m := trycloudflareRe.FindString(line); m != "" {
				select {
				case urlCh <- m:
				default:
				}
			}
		}
	}()

	return &tunnelHandle{cmd: cmd, tempDir: tempDir}, nil
}

var logFileHandle *os.File

// setupLogging writes logs to both the terminal and a file (cfg.LogPath, or
// LOG_FILE) simultaneously — without this, running the server in the
// background (nohup, systemd without stdout capture, etc.) would lose the
// entire history.
func setupLogging(cfg *Config) (io.Closer, error) {
	if err := os.MkdirAll(filepath.Dir(cfg.LogPath), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(cfg.LogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	logFileHandle = f
	log.SetOutput(io.MultiWriter(os.Stdout, f))
	log.SetFlags(log.Ldate | log.Ltime)
	return f, nil
}

func isStdoutTTY() bool {
	info, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return (info.Mode() & os.ModeCharDevice) != 0
}

const ansiBoldCyan = "\x1b[1;36m"
const ansiReset = "\x1b[0m"

// printHighlight logs the same line log.Printf would (same timestamp, same
// file), but on the terminal (only if it really is one — we never put ANSI
// codes in a log file or a pipe) highlights it in color to stand out from
// the rest of the text. Used only for the tunnel URL line, the single most
// important piece of information on startup.
func printHighlight(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	ts := time.Now().Format("2006/01/02 15:04:05")
	if logFileHandle != nil {
		fmt.Fprintf(logFileHandle, "%s %s\n", ts, msg)
	}
	if isStdoutTTY() {
		fmt.Fprintf(os.Stdout, "%s %s%s%s\n", ts, ansiBoldCyan, msg, ansiReset)
	} else {
		fmt.Fprintf(os.Stdout, "%s %s\n", ts, msg)
	}
}
