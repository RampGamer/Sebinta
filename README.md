# Filepad

Aplicação de partilha rápida de texto e ficheiros entre computadores, ao estilo do Dontpad: abres um URL como `https://oteudominio.com/o-que-quiseres` e o "pad" é criado ou aberto automaticamente. Sem contas, sem login, sem base de dados de utilizadores.

Além de texto com gravação automática, cada pad suporta upload de imagens, vídeos e ficheiros de qualquer tipo, com sincronização quase em tempo real entre dispositivos que tenham o mesmo pad aberto.

## Índice

- [Funcionalidades](#funcionalidades)
- [Limpeza de metadados (app desktop / CLI)](#limpeza-de-metadados-app-desktop--cli)
- [Correr sem Docker (servidor standalone em Go)](#correr-sem-docker-servidor-standalone-em-go)
- [Pré-requisitos](#pré-requisitos)
- [1. Criar o túnel na Cloudflare](#1-criar-o-túnel-na-cloudflare)
- [2. Configurar o `.env`](#2-configurar-o-env)
- [3. Arrancar a aplicação](#3-arrancar-a-aplicação)
- [4. Parar e reiniciar](#4-parar-e-reiniciar)
- [5. Atualizar](#5-atualizar)
- [6. Backup e restauro dos dados](#6-backup-e-restauro-dos-dados)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Trade-offs e decisões técnicas](#trade-offs-e-decisões-técnicas)
- [Resolução de problemas](#resolução-de-problemas)

## Funcionalidades

- Criação implícita de pads por URL, com texto gravado automaticamente (debounce, sem botão "guardar").
- Sincronização quase em tempo real entre dispositivos via WebSocket, com fallback automático para polling curto se o WebSocket não conseguir ligar.
- Upload por botão, drag & drop, ou colar (Ctrl+V) — imagens e vídeos com pré-visualização inline, restantes ficheiros numa lista com nome, tamanho, download e apagar.
- Limite de tamanho por ficheiro configurável, barra de progresso, e limpeza automática opcional de ficheiros antigos (TTL).
- O próprio Filepad **não limpa metadados** — guarda o ficheiro tal como o recebe (ver secção seguinte para quem precisa disso).
- Password global do site (opcional) e password por pad (opcional).
- Validação de tipo real por magic bytes, nomes de ficheiro aleatórios em disco, proteção CSRF, rate limiting, cabeçalhos de segurança (CSP restritiva, sem CDNs externos), texto sempre escapado no frontend.
- Arranque com um único `docker compose up -d`, sem portas expostas na máquina — o acesso é só através de um túnel Cloudflare.

## Limpeza de metadados (app desktop / CLI)

O servidor e a página web do Filepad **não limpam metadados** — um ficheiro
sobe exatamente como foi recebido. Se precisares de garantir que um
documento não leva autor, empresa, GPS ou etiquetas de classificação/DLP
(Titus, Microsoft Purview, etc.) quando o partilhas, faz a limpeza **antes**
do upload, com uma destas ferramentas:

- **App desktop (`desktop/`)** — Electron, mesma interface do browser
  (abre a página real do teu Filepad), mas intercepta o upload para limpar
  localmente documentos Office (`.docx`/`.xlsx`/`.pptx`, incluindo Custom
  XML Parts de DLP) e PDF antes de saírem do computador. A limpeza é
  opcional, exceto quando deteta tags de DLP num documento Office — nesse
  caso é sempre aplicada. Ver `desktop/README.md`.
- **CLI (`cli/`)** — `filepad-clean`, ferramenta em Go sem dependências,
  para limpar (e opcionalmente enviar) documentos Office a partir da linha
  de comandos ou de scripts. Ver `cli/README.md`.

Outros tipos de ficheiro (imagens, vídeo, áudio, Office legado `.doc`/`.xls`/`.ppt`)
sobem sem qualquer limpeza — nem a app desktop nem o CLI cobrem esses
formatos atualmente.

## Correr sem Docker (servidor standalone em Go)

Para quem preferir não usar Docker, `standalone/` tem uma porta completa do
servidor em Go: um único binário estático, sem runtime a instalar, sem
`npm install`, sem toolchain C. Paridade funcional total com o servidor
Node desta secção — mesmas rotas, mesmo modelo de cookies/CSRF, mesmo
WebSocket, mesmo frontend embutido no binário — e **partilha o mesmo
schema SQLite**, por isso o mesmo `DATA_DIR`/`UPLOADS_DIR` funciona com
qualquer um dos dois (não correr os dois em simultâneo sobre a mesma
pasta).

```bash
./filepad-server-linux-amd64   # binário pré-compilado, nas Releases do GitHub
```

Usa as mesmas variáveis de ambiente (o mesmo `.env` da raiz serve). Para
expor publicamente sem Docker, corre o `cloudflared` como processo à parte:

```bash
cloudflared tunnel --url http://localhost:3000
```

Ver `standalone/README.md` para instruções completas (compilar a partir do
código, cross-compile para as 3 plataformas, etc.).

## Pré-requisitos

- Um servidor Linux (ou qualquer máquina) com [Docker](https://docs.docker.com/engine/install/) e o plugin `docker compose` instalados.
- Uma conta gratuita na [Cloudflare](https://dash.cloudflare.com/sign-up) com um domínio já a usar os nameservers da Cloudflare (podes usar um domínio que já tenhas, ou registar um).
- Não precisas de abrir portas no router nem de IP público — o túnel da Cloudflare trata disso.

## 1. Criar o túnel na Cloudflare

1. Entra no [dashboard da Cloudflare](https://dash.cloudflare.com) e vai a **Zero Trust** (menu lateral esquerdo; se for a primeira vez, pede para escolheres um nome de equipa — qualquer nome serve, é só para o dashboard).
2. No menu do Zero Trust, vai a **Networks → Tunnels**.
3. Clica em **Create a tunnel**.
4. Escolhe o tipo de conector **Cloudflared** e dá um nome ao túnel (ex.: `filepad`).
5. No passo **"Install and run a connector"**, a Cloudflare mostra-te um comando com um token comprido (`--token eyJ...`). **Copia só o valor do token** — é isso que vais colocar no `.env` como `TUNNEL_TOKEN`. Não precisas de correr esse comando manualmente; o `docker-compose.yml` já trata de correr o `cloudflared` por ti.
6. Continua para o passo **"Route traffic"** / **Public Hostname**:
   - **Subdomain**: o que quiseres (ex.: `notas`), ou deixa vazio para usar o domínio raiz.
   - **Domain**: escolhe o teu domínio já ligado à Cloudflare.
   - **Service**: tipo `HTTP`, endereço `app:3000` — este é o nome do serviço Docker (`app`) definido no `docker-compose.yml`, resolvido automaticamente pela rede interna do Docker. **Não uses `localhost` nem um IP** — o `cloudflared` corre dentro da rede Docker, não na tua máquina.
7. Guarda. Ao fim de alguns segundos o hostname público (ex.: `https://notas.oteudominio.com`) já deve estar associado ao túnel.

O HTTPS é tratado inteiramente pela Cloudflare — a tua aplicação nunca precisa de certificados nem de portas abertas.

## 2. Configurar o `.env`

```bash
cp .env.example .env
```

Edita o `.env` e preenche pelo menos o `TUNNEL_TOKEN` obtido acima:

```dotenv
TUNNEL_TOKEN=eyJhIjoixxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...

# Opcional: protege todo o site com uma password
SITE_PASSWORD=uma-password-forte-aqui

# Opcional: limite de tamanho por ficheiro (megabytes)
MAX_FILE_SIZE_MB=500

# Opcional: apaga ficheiros com mais de N dias automaticamente
FILE_TTL_DAYS=

# Recomendado em produção: fixa este valor para as sessões sobreviverem a restarts
COOKIE_SECRET=$(openssl rand -hex 32)
```

Gera um `COOKIE_SECRET` fixo com:

```bash
openssl rand -hex 32
```

Todas as variáveis estão documentadas com comentários no próprio `.env.example`.

## 3. Arrancar a aplicação

```bash
./start.sh
```

Isto constrói a imagem da aplicação, arranca os dois serviços (`app` e
`cloudflared`), espera que fiquem saudáveis e **imprime o link de acesso**.
Em modo Quick Tunnel (sem `TUNNEL_TOKEN` no `.env` — o omissão), a
Cloudflare atribui um domínio aleatório `*.trycloudflare.com` a cada
arranque, que só aparece nos logs do `cloudflared`; o script vai lá buscá-lo
por ti, não precisas de procurar. Com um túnel nomeado (`TUNNEL_TOKEN`
definido), o script avisa-te disso e o link é o domínio fixo que escolheste
no Cloudflare Zero Trust.

Equivalente manual, se preferires não usar o script:

```bash
docker compose up -d
docker compose logs cloudflared   # o link *.trycloudflare.com aparece aqui
```

Para veres os logs em direto:

```bash
docker compose logs -f
```

Para confirmares que a app está saudável:

```bash
docker compose ps
```

(deve aparecer `healthy` na coluna de estado do serviço `app`).

## 4. Parar e reiniciar

```bash
# Parar (mantém os volumes de dados)
docker compose down

# Reiniciar
docker compose up -d

# Reiniciar só um serviço
docker compose restart app
```

## 5. Atualizar

Quando fizeres alterações ao código, ou quiseres atualizar as imagens base:

```bash
git pull                    # se estiveres a gerir o projeto com git
docker compose build app    # reconstrói a imagem da aplicação
docker compose up -d        # recria os containers com a nova imagem
```

Para atualizar só a imagem do `cloudflared` para a mais recente:

```bash
docker compose pull cloudflared
docker compose up -d cloudflared
```

Os dados (base de dados SQLite e ficheiros enviados) estão em volumes Docker nomeados e sobrevivem a estes comandos.

## 6. Backup e restauro dos dados

Os dados vivem em dois volumes Docker: `filepad_data` (base de dados SQLite) e `filepad_uploads` (ficheiros). O nome exato dos volumes tem o prefixo do projeto — confirma com:

```bash
docker volume ls | grep filepad
```

### Backup

```bash
mkdir -p backups
docker run --rm \
  -v filepad_filepad_data:/data \
  -v filepad_filepad_uploads:/uploads \
  -v "$(pwd)/backups":/backup \
  alpine tar czf /backup/filepad-backup-$(date +%Y%m%d-%H%M%S).tar.gz -C / data uploads
```

(ajusta `filepad_filepad_data` / `filepad_filepad_uploads` para os nomes reais devolvidos por `docker volume ls`, que dependem do nome da pasta do projeto).

### Restauro

```bash
docker compose down
docker run --rm \
  -v filepad_filepad_data:/data \
  -v filepad_filepad_uploads:/uploads \
  -v "$(pwd)/backups":/backup \
  alpine sh -c "cd / && tar xzf /backup/filepad-backup-XXXXXXXX-XXXXXX.tar.gz"
docker compose up -d
```

## Estrutura do projeto

```
filepad/
├── docker-compose.yml       # serviços app + cloudflared
├── Dockerfile                # imagem da app (Node)
├── .env.example
├── package.json
├── server/
│   ├── index.js               # bootstrap Express + HTTP + WebSocket
│   ├── config.js               # leitura de variáveis de ambiente
│   ├── db.js                    # schema SQLite (better-sqlite3)
│   ├── auth.js                   # password do site, password de pad, CSRF
│   ├── ws.js                      # sincronização em tempo real
│   ├── middleware/
│   │   ├── security.js             # cabeçalhos (helmet/CSP)
│   │   └── rateLimit.js             # limitadores de pedidos
│   ├── routes/
│   │   ├── auth.js                   # /api/auth/*
│   │   ├── pad.js                     # /api/pad/*
│   │   └── files.js                    # /api/files/* (upload/download/preview)
│   └── services/
│       ├── padStore.js                 # acesso a pads/ficheiros na BD
│       ├── storage.js                   # caminhos seguros em disco
│       ├── fileType.js                   # deteção por magic bytes
│       └── cleanup.js                     # tarefa agendada (TTL)
├── public/
│   ├── pad.html / login.html
│   ├── css/style.css
│   └── js/
│       ├── app.js                        # lógica do pad (texto, WS, ficheiros)
│       └── upload.js                      # drag&drop, colar, progresso, sem limpeza
├── cli/                       # filepad-clean: CLI Go, limpa Office localmente (ver cli/README.md)
├── desktop/                    # app Electron: limpa Office/PDF localmente antes do upload (ver desktop/README.md)
└── standalone/                  # servidor em Go, sem Docker, binário único (ver standalone/README.md)
```

## Variáveis de ambiente

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `TUNNEL_TOKEN` | Sim (para o `cloudflared`) | — | Token do túnel Cloudflare |
| `SITE_PASSWORD` | Não | vazia (site aberto) | Password global do site |
| `MAX_FILE_SIZE_MB` | Não | `500` | Limite de tamanho por ficheiro |
| `FILE_TTL_DAYS` | Não | vazio (desativado) | Apaga ficheiros com mais de N dias |
| `COOKIE_SECRET` | Recomendada | gerado aleatoriamente no arranque | Assina os cookies de sessão |
| `COOKIE_SECURE` | Não | `true` | Só desativar em testes locais sem HTTPS |

## Trade-offs e decisões técnicas

- **Pad IDs com `/` e endpoints de ficheiros/password**: como qualquer caminho de URL (incluindo com barras) é um pad válido, os endpoints de ficheiros e de password usam `?id=` (e o WebSocket usa `?pad=`) em vez de o incluírem no próprio caminho do URL — evita ambiguidade entre "um pad chamado `notas/files`" e "o endpoint de ficheiros do pad `notas`".
- **Sem limpeza de metadados no servidor nem na página web**: o Filepad guarda ficheiros tal como os recebe. Quem precisar de garantir que um documento não leva metadados sensíveis faz essa limpeza antes do upload, com a [app desktop](#limpeza-de-metadados-app-desktop--cli) ou o CLI — mantém o servidor simples e sem dependências pesadas (`exiftool`/`ffmpeg`).
- **Sessões por cookie, sem base de dados de utilizadores**: mantém o projeto simples (sem tabela de sessões, sem limpeza de sessões expiradas). Custo: se mudares o `COOKIE_SECRET` (ou não o fixares e o container reiniciar), todas as sessões — incluindo passwords de pads desbloqueados — são invalidadas. Definir um `COOKIE_SECRET` fixo evita isto.
- **Password por pad guardada em cookie assinado, não em sessão no servidor**: mantém-se sem tabela de sessões; o "desbloqueio" de um pad é local ao browser que o desbloqueou, tal como no site em geral.

## Resolução de problemas

**O túnel aparece "inactive" no dashboard da Cloudflare.**
Confirma que `TUNNEL_TOKEN` no `.env` está correto e sem espaços a mais, depois `docker compose up -d cloudflared` e `docker compose logs cloudflared`.

**A app não fica "healthy".**
`docker compose logs app` — o healthcheck usa `curl http://127.0.0.1:3000/health` dentro do próprio container; se falhar, normalmente é um erro no arranque do Node (ver os logs) ou falta de espaço em disco para a base de dados.

**Quero desativar a password do site outra vez.**
Apaga ou deixa vazio o `SITE_PASSWORD` no `.env` e faz `docker compose up -d app`.
