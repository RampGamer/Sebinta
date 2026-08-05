# filepad-server (standalone)

Porta em Go do servidor Filepad (`server/`, Node/Express), para quem quer
correr **sem Docker** e com o mínimo de dependências possível: um único
binário estático, sem runtime a instalar, sem `npm install`, sem toolchain
C (o driver SQLite usado, `modernc.org/sqlite`, é Go puro).

Paridade funcional com o servidor Node **no estado atual** (sem limpeza de
metadados — ver `desktop/` ou `cli/` para isso): mesmas rotas, mesmo modelo
de cookies/CSRF, mesmo protocolo WebSocket, mesmo frontend (`public/`,
embutido no binário via `go:embed` — não precisas de mais nenhum ficheiro
ao lado do executável).

**Os dois servidores partilham o mesmo schema SQLite** — podes apontar
`DATA_DIR`/`UPLOADS_DIR` para a mesma pasta usada pela versão Docker e ler
os mesmos pads/ficheiros sem migração nenhuma (não corras os dois ao mesmo
tempo sobre a mesma pasta).

## Correr já compilado

Descarrega o binário do teu sistema a partir das
[Releases](https://github.com/RampGamer/filepad/releases) e corre-o
diretamente:

```bash
./filepad-server-linux-amd64
```

Por omissão arranca na porta 3000, sem password de site, e cria `data/` e
`uploads/` na pasta onde o corres. Configura com as mesmas variáveis de
ambiente da versão Docker (o mesmo `.env` da raiz do projeto serve — este
binário lê um `.env` na pasta onde corre, se existir):

```bash
PORT=3000 SITE_PASSWORD=umapassword COOKIE_SECRET=$(openssl rand -hex 32) ./filepad-server-linux-amd64
```

`TUNNEL_TOKEN` não se aplica aqui (é só para o serviço `cloudflared` do
Docker Compose) — ver secção seguinte para expor publicamente sem Docker.

## Expor publicamente sem Docker (túnel Cloudflare)

O `cloudflared` também é um binário único — corre-o como um segundo
processo, sem Docker nenhum envolvido:

```bash
./filepad-server-linux-amd64 &
cloudflared tunnel --url http://localhost:3000
```

O link `*.trycloudflare.com` aparece nos logs do `cloudflared`, tal como no
modo Docker.

## Compilar a partir do código

Requer Go 1.22+ (usa padrões de `net/http.ServeMux` introduzidos nessa
versão).

```bash
cd standalone
go build -o filepad-server .
```

### Cross-compile para os 4 sistemas operativos

```bash
CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -o dist/filepad-server-linux-amd64     .
CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -o dist/filepad-server-macos-arm64     .
CGO_ENABLED=0 GOOS=darwin  GOARCH=amd64 go build -o dist/filepad-server-macos-amd64     .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o dist/filepad-server-windows-amd64.exe .
```

`CGO_ENABLED=0` funciona em todos porque o driver SQLite (`modernc.org/sqlite`)
é Go puro — sem isto não seria possível fazer cross-compile a partir de uma
única máquina sem um toolchain C por plataforma.

### Se alterares o frontend (`public/`)

Este projeto embute uma **cópia** de `../public/` (`standalone/public/`),
porque `go:embed` não consegue referenciar ficheiros fora da árvore do
módulo. Depois de mexer em `public/` na raiz, sincroniza antes de
recompilar:

```bash
rm -rf standalone/public && cp -r public standalone/public
```

## Variáveis de ambiente

As mesmas de `server/config.js` / `.env.example` da raiz: `PORT`,
`DATA_DIR`, `UPLOADS_DIR`, `SITE_PASSWORD`, `COOKIE_SECRET`,
`COOKIE_SECURE`, `MAX_FILE_SIZE_MB`, `FILE_TTL_DAYS`,
`MAX_PAD_CONTENT_CHARS`, `TRUST_PROXY`.

## Fora de âmbito

- Paridade byte-a-byte de todos os cabeçalhos que o `helmet` (Node)
  aplicava por omissão — replicam-se os que importam para a segurança
  (CSP, `nosniff`, `X-Frame-Options`, HSTS, etc.), não a lista completa.
- Empacotamento do `cloudflared` junto do binário — corre-se como processo
  separado (ver acima).
