# Filepad

Aplicação de partilha rápida de texto e ficheiros entre computadores, ao estilo do Dontpad: abres um URL como `https://oteudominio.com/o-que-quiseres` e o "pad" é criado ou aberto automaticamente. Sem contas, sem login, sem base de dados de utilizadores.

Além de texto com gravação automática, cada pad suporta upload de imagens, vídeos e ficheiros de qualquer tipo, com sincronização quase em tempo real entre dispositivos que tenham o mesmo pad aberto.

## Índice

- [Funcionalidades](#funcionalidades)
- [Como funciona a limpeza de metadados](#como-funciona-a-limpeza-de-metadados)
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
- **Limpeza de metadados em duas camadas** (ver secção seguinte) — nenhum ficheiro fica acessível sem passar por ela.
- Password global do site (opcional) e password por pad (opcional).
- Validação de tipo real por magic bytes, nomes de ficheiro aleatórios em disco, proteção CSRF, rate limiting, cabeçalhos de segurança (CSP restritiva, sem CDNs externos), texto sempre escapado no frontend.
- Arranque com um único `docker compose up -d`, sem portas expostas na máquina — o acesso é só através de um túnel Cloudflare.

## Como funciona a limpeza de metadados

Este é o requisito mais delicado do projeto, por isso vale a pena explicar o desenho:

**Camada 1 — no browser, antes do upload sair do teu computador** (só para os tipos onde isto é tecnicamente viável e fiável):

| Tipo | Técnica |
|---|---|
| Imagens JPEG/PNG/WebP | Reencode via `OffscreenCanvas` num Web Worker — o canvas só lê pixels, nunca preserva EXIF/GPS |
| PDF | `pdf-lib`: limpa o dicionário Info e remove a stream XMP do catálogo; a gravação reescreve o ficheiro de raiz, descartando "incremental updates" antigos |
| Office OOXML (`.docx`/`.xlsx`/`.pptx`) | `fflate` (ZIP): substitui `docProps/core.xml` e `docProps/app.xml` por versões vazias, remove `docProps/custom.xml` e a thumbnail |

Se a limpeza destes tipos falhar no browser (ex.: PDF encriptado, ficheiro corrompido), **o upload é bloqueado ali mesmo** — o ficheiro original nunca chega a ser enviado.

Vídeo, áudio, Office legado (`.doc`/`.xls`/`.ppt`) e todos os outros tipos **não têm limpeza viável no browser** (não há forma fiável e leve de reescrever um `.mp4` ou um `.doc` binário em JavaScript do browser) e seguem diretamente para a camada 2.

**Camada 2 — no servidor, obrigatória para TODOS os ficheiros** (mesmo os já limpos na camada 1 — funciona como garantia final):

1. O ficheiro é gravado primeiro numa pasta de **quarentena**, fora do armazenamento definitivo.
2. É identificado por magic bytes (não pela extensão).
3. É limpo com `exiftool -all=` (imagens, PDF, documentos) ou `ffmpeg -map_metadata -1` (vídeo/áudio, com cópia de stream sempre que possível).
4. Só se a limpeza terminar com sucesso é que o ficheiro é movido para o armazenamento definitivo e passa a existir na base de dados.
5. Se falhar, o ficheiro de quarentena é apagado e o utilizador vê um erro claro — nunca fica um caminho de código onde um ficheiro por limpar se torne acessível.

Ficheiros verdadeiramente genéricos (ex.: um `.bin` arbitrário, um `.zip` que não é um documento Office) não têm um formato de metadados conhecido para limpar; nesse caso a camada 2 ainda corre em modo best-effort mas uma eventual falha não bloqueia o upload, porque não há nada de específico para garantir.

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

Um único comando, a partir da pasta do projeto:

```bash
docker compose up -d
```

Isto constrói a imagem da aplicação (instala `exiftool` e `ffmpeg` automaticamente), arranca os dois serviços (`app` e `cloudflared`), e liga o túnel. Passados uns segundos, o pad já deve estar acessível no hostname que configuraste na Cloudflare, ex.:

```
https://notas.oteudominio.com/o-que-quiseres
```

Para veres os logs:

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
├── Dockerfile                # imagem da app (Node + exiftool + ffmpeg)
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
│       ├── quarantine.js                  # limpeza server-side (exiftool/ffmpeg)
│       └── cleanup.js                      # tarefa agendada (TTL)
└── public/
    ├── pad.html / login.html
    ├── css/style.css
    └── js/
        ├── app.js                        # lógica do pad (texto, WS, ficheiros)
        ├── upload.js                      # drag&drop, colar, progresso
        ├── metadata/
        │   ├── worker.js                    # Web Worker de limpeza
        │   ├── image-clean.js
        │   ├── pdf-clean.js
        │   └── office-clean.js
        └── vendor/                          # pdf-lib e fflate servidos localmente
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
- **Limpeza de imagem no browser via re-encode**: garante remoção total de EXIF (incluindo GPS), mas é sempre uma reompressão (para JPEG/WebP, com qualidade 0.92) — não é bit-a-bit idêntica ao original. É a única forma fiável de garantir que os metadados não saem do dispositivo de origem.
- **Vídeo/áudio e Office legado sem limpeza no browser**: reescrever contentores de vídeo ou o formato binário OLE2 (`.doc`/`.xls`/`.ppt`) em JavaScript do browser não é viável com bibliotecas leves — ficam só com a camada de quarentena no servidor (`ffmpeg`/`exiftool`), que continua a garantir que nada fica acessível sem ser limpo.
- **`ffmpeg -c copy` com fallback para reencode**: tenta sempre remuxar sem recodificar (rápido, sem perda). Se o contentor recusar, faz reencode completo como última tentativa — mais lento, mas garante que a limpeza nunca falha por incompatibilidade evitável.
- **Sessões por cookie, sem base de dados de utilizadores**: mantém o projeto simples (sem tabela de sessões, sem limpeza de sessões expiradas). Custo: se mudares o `COOKIE_SECRET` (ou não o fixares e o container reiniciar), todas as sessões — incluindo passwords de pads desbloqueados — são invalidadas. Definir um `COOKIE_SECRET` fixo evita isto.
- **Password por pad guardada em cookie assinado, não em sessão no servidor**: mantém-se sem tabela de sessões; o "desbloqueio" de um pad é local ao browser que o desbloqueou, tal como no site em geral.

## Resolução de problemas

**O túnel aparece "inactive" no dashboard da Cloudflare.**
Confirma que `TUNNEL_TOKEN` no `.env` está correto e sem espaços a mais, depois `docker compose up -d cloudflared` e `docker compose logs cloudflared`.

**A app não fica "healthy".**
`docker compose logs app` — o healthcheck usa `curl http://127.0.0.1:3000/health` dentro do próprio container; se falhar, normalmente é um erro no arranque do Node (ver os logs) ou falta de espaço em disco para a base de dados.

**Uploads de imagem/PDF/Office falham sempre com "limpeza de metadados falhou".**
Confirma que a imagem foi construída com sucesso (`docker compose build app`) — o build instala `exiftool` e `ffmpeg`; se a imagem for antiga ou o build tiver falhado a meio, estes binários podem faltar.

**Quero desativar a password do site outra vez.**
Apaga ou deixa vazio o `SITE_PASSWORD` no `.env` e faz `docker compose up -d app`.
