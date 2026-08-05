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

// O binário oficial do cloudflared vem embutido (ver tunnel_<os>_<arch>.go,
// um por plataforma suportada — só o correspondente ao alvo de cada build
// entra no binário final). Não é possível "embeber" o cloudflared como
// biblioteca Go: o seu ponto de entrada é package main (não pode ser
// importado) e as internals (supervisor, orchestration, ...) não são uma
// API pública estável — a via realista é correr o mesmo binário oficial,
// mas sem exigir que o utilizador o instale à parte.

var trycloudflareRe = regexp.MustCompile(`https://[a-zA-Z0-9-]+\.trycloudflare\.com`)

// extractEmbeddedCloudflared grava o binário embutido num ficheiro
// temporário executável e devolve o caminho.
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

// tunnelHandle junta o processo do cloudflared e a pasta temporária onde o
// binário embutido foi extraído, para o chamador poder parar e limpar tudo
// de forma síncrona no encerramento (não dá para confiar só no goroutine de
// leitura para isso — o processo pode terminar antes dele correr).
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

// startTunnel arranca o cloudflared embutido (Quick Tunnel por omissão, ou
// um túnel nomeado se TUNNEL_TOKEN estiver definido — mesma variável usada
// pelo docker-compose.yml). Cada linha do seu output é encaminhada para o
// logger da app (prefixo "[cloudflared]"); quando aparece um URL
// *.trycloudflare.com, é enviado a urlCh.
func startTunnel(cfg *Config, urlCh chan<- string) (*tunnelHandle, error) {
	binPath, err := extractEmbeddedCloudflared()
	if err != nil {
		return nil, fmt.Errorf("não foi possível preparar o cloudflared embutido: %w", err)
	}
	tempDir := filepath.Dir(binPath)

	var args []string
	if cfg.TunnelToken != "" {
		log.Println("[cloudflared] TUNNEL_TOKEN definido — a ligar túnel nomeado.")
		args = []string{"tunnel", "run"}
	} else {
		log.Println("[cloudflared] a pedir um Quick Tunnel (sem conta Cloudflare)...")
		args = []string{"tunnel", "--url", "http://localhost:" + cfg.Port}
	}

	cmd := exec.Command(binPath, args...)
	if cfg.TunnelToken != "" {
		cmd.Env = append(os.Environ(), "TUNNEL_TOKEN="+cfg.TunnelToken)
	}
	// cloudflared escreve os logs interessantes (incluindo o URL do Quick
	// Tunnel) em stderr — unificamos os dois no mesmo pipe para não perder
	// nenhuma linha nem complicar com dois leitores.
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw

	if err := cmd.Start(); err != nil {
		os.RemoveAll(tempDir)
		return nil, fmt.Errorf("não foi possível arrancar o cloudflared: %w", err)
	}

	// Espelha a saída do processo para o pipe de leitura; fechar o pipe
	// quando o processo terminar é o que faz o scanner abaixo sair do loop.
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

// setupLogging escreve os logs simultaneamente no terminal e num ficheiro
// (cfg.LogPath, ou LOG_FILE) — sem isto, correr o servidor em background
// (nohup, systemd sem captura de stdout, etc.) perdia todo o histórico.
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

// printHighlight regista a mesma linha que log.Printf registaria (mesmo
// timestamp, mesmo ficheiro), mas no terminal (se for mesmo um terminal —
// nunca metemos códigos ANSI num ficheiro de log ou numa pipe) destaca-a a
// cores para se distinguir do resto do texto. Usado só para a linha do URL
// do túnel, que é a informação mais importante ao arrancar.
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
