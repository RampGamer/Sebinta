package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
)

// SebintaClient fala com a API HTTP do Sebinta, reproduzindo o mesmo fluxo
// que o browser faz: obter o cookie CSRF (double-submit), autenticar-se
// opcionalmente contra a password do site e/ou de um pad, e só depois
// enviar o ficheiro para /api/files.
type SebintaClient struct {
	baseURL string
	http    *http.Client
	csrf    string
}

func NewSebintaClient(server string) (*SebintaClient, error) {
	u, err := url.Parse(server)
	if err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" {
		return nil, fmt.Errorf("indica um URL completo, ex.: https://notas.exemplo.com")
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	return &SebintaClient{
		baseURL: strings.TrimRight(server, "/"),
		http:    &http.Client{Jar: jar},
	}, nil
}

// EnsureCsrf faz um pedido GET inofensivo só para receber o cookie fp_csrf
// que o servidor define em qualquer resposta (server/auth.js:ensureCsrfCookie).
func (c *SebintaClient) EnsureCsrf() error {
	req, err := http.NewRequest(http.MethodGet, c.baseURL+"/health", nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("resposta inesperada do servidor (status %d) — confirma o URL", resp.StatusCode)
	}
	u, _ := url.Parse(c.baseURL)
	for _, ck := range c.http.Jar.Cookies(u) {
		if ck.Name == "fp_csrf" {
			c.csrf = ck.Value
		}
	}
	if c.csrf == "" {
		return fmt.Errorf("o servidor não devolveu o cookie CSRF esperado")
	}
	return nil
}

func (c *SebintaClient) postJSON(path string, payload interface{}) (*http.Response, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", c.csrf)
	return c.http.Do(req)
}

func readAPIError(resp *http.Response) string {
	var data struct {
		Error string `json:"error"`
	}
	b, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(b, &data)
	if data.Error != "" {
		return data.Error
	}
	return fmt.Sprintf("status %d", resp.StatusCode)
}

func (c *SebintaClient) SiteLogin(password string) error {
	resp, err := c.postJSON("/api/auth/login", map[string]string{"password": password})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s", readAPIError(resp))
	}
	return nil
}

func (c *SebintaClient) UnlockPad(pad, password string) error {
	resp, err := c.postJSON("/api/pad/unlock?id="+url.QueryEscape(pad), map[string]string{"password": password})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s", readAPIError(resp))
	}
	return nil
}

// UploadFile envia o ficheiro (já limpo) para /api/files?id=<pad> e devolve
// o id atribuído pelo servidor.
func (c *SebintaClient) UploadFile(pad, filename string, data []byte) (string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	if err := mw.Close(); err != nil {
		return "", err
	}

	req, err := http.NewRequest(http.MethodPost, c.baseURL+"/api/files?id="+url.QueryEscape(pad), &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("X-CSRF-Token", c.csrf)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusCreated:
		var data2 struct {
			ID string `json:"id"`
		}
		b, _ := io.ReadAll(resp.Body)
		_ = json.Unmarshal(b, &data2)
		return data2.ID, nil
	case http.StatusUnauthorized:
		return "", fmt.Errorf("password do site necessária (usa -site-password)")
	case http.StatusLocked:
		return "", fmt.Errorf("este pad está protegido (usa -pad-password)")
	default:
		return "", fmt.Errorf("%s", readAPIError(resp))
	}
}
