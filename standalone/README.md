# filepad-server (standalone)

Porta em Go do servidor Filepad (`server/`, Node/Express), para quem quer
correr **sem Docker** e sem instalar nada: um único binário estático, sem
runtime a instalar, sem `npm install`, sem toolchain C (o driver SQLite
usado, `modernc.org/sqlite`, é Go puro) — e com o **próprio `cloudflared`
embutido**, para não teres de instalar isso à parte também. Descarregas um
ficheiro, corres, e já tens o pad acessível publicamente.

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

Isto já é o suficiente: arranca o servidor na porta 3000, liga um túnel
Cloudflare Quick Tunnel automaticamente (usando o `cloudflared` embutido no
próprio binário — nada para instalar) e **imprime o link assim que fica
pronto**:

```
Filepad disponível em: https://palavras-aleatorias.trycloudflare.com
```

Esse link muda a cada arranque (é assim que o Quick Tunnel funciona — sem
conta Cloudflare, sem domínio fixo). Para um domínio fixo, define
`TUNNEL_TOKEN` (o mesmo token documentado no README principal para o
túnel nomeado — este binário lê-o automaticamente, tal como o serviço
`cloudflared` do Docker Compose). Para correr só localmente, sem túnel
nenhum:

```bash
DISABLE_TUNNEL=true ./filepad-server-linux-amd64
```

Configura o resto com as mesmas variáveis de ambiente da versão Docker (o
mesmo `.env` da raiz do projeto serve — este binário lê um `.env` na pasta
onde corre, se existir):

```bash
SITE_PASSWORD=umapassword COOKIE_SECRET=$(openssl rand -hex 32) ./filepad-server-linux-amd64
```

Os logs (incluindo os do `cloudflared`) também ficam gravados em
`DATA_DIR/filepad.log` (configurável com `LOG_FILE`), para poderes correr
o binário em background sem perder o histórico.

## Compilar a partir do código

Requer Go 1.22+ (usa padrões de `net/http.ServeMux` introduzidos nessa
versão).

`go:embed` precisa dos binários do `cloudflared` presentes em disco em
tempo de compilação (um por plataforma, ver "Como o cloudflared fica
embutido" abaixo) — descarrega-os primeiro:

```bash
cd standalone
./fetch-cloudflared.sh   # descarrega para assets/ (não fica no repositório — são ~40-55MB cada)
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
única máquina sem um toolchain C por plataforma. `fetch-cloudflared.sh`
descarrega os 4 binários de uma vez (`assets/cloudflared-linux-amd64`,
`-darwin-amd64`, `-darwin-arm64`, `-windows-amd64.exe`); cada `go build`
acima só embute o que corresponde ao seu `GOOS`/`GOARCH` (ver
`tunnel_<os>_<arch>.go` — um ficheiro por plataforma, com o nome do
ficheiro a definir automaticamente para que alvo compila, sem precisar de
`//go:build`).

### Como o cloudflared fica embutido

Não é possível importar o `cloudflared` como biblioteca Go — o seu ponto de
entrada é `package main` (o próprio Go impede importar isso de outro
módulo) e as packages internas que fazem o trabalho a sério
(`supervisor`, `orchestration`, ...) não são uma API pública pensada para
reutilização externa. A via realista, e a que este projeto usa, é embutir
o **binário oficial** via `go:embed` e correr o mesmo processo que
correrias manualmente — só que sem teres de o instalar tu.

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
`MAX_PAD_CONTENT_CHARS`, `TRUST_PROXY`, `TUNNEL_TOKEN`. Mais três
específicas desta versão:

| Variável | Omissão | Descrição |
|---|---|---|
| `DISABLE_TUNNEL` | `false` | `true` para não ligar nenhum túnel — só acesso local |
| `LOG_FILE` | `DATA_DIR/filepad.log` | onde gravar os logs (além do terminal) |

## Fora de âmbito

- Paridade byte-a-byte de todos os cabeçalhos que o `helmet` (Node)
  aplicava por omissão — replicam-se os que importam para a segurança
  (CSP, `nosniff`, `X-Frame-Options`, HSTS, etc.), não a lista completa.
- Rotação de logs — `LOG_FILE` cresce sem limite; para deployments de longa
  duração, faz rotação externamente (`logrotate`, etc.) ou apaga/arquiva o
  ficheiro periodicamente.
