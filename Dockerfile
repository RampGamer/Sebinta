# syntax=docker/dockerfile:1

# ---- Fase 1: instala dependências Node (inclui compilação nativa do better-sqlite3) ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public

# ---- Fase 2: imagem final, só com o runtime necessário ----
FROM node:20-bookworm-slim
WORKDIR /app

# exiftool (limpeza de metadados de imagens/PDF/documentos legados) e ffmpeg
# (limpeza de vídeo/áudio) — camada de quarentena obrigatória no servidor.
# libarchive-zip-perl: sem este módulo Perl o exiftool nem sequer consegue
# LER corretamente ficheiros Office OOXML (.docx/.xlsx/.pptx, que são ZIPs;
# sem ele trata-os como ZIP genérico e ignora todas as propriedades lá
# dentro). A ESCRITA/limpeza destes formatos não depende do exiftool — é
# feita em Node puro (server/services/officeClean.js) porque a versão de
# exiftool disponível no Debian não suporta escrever OOXML — mas manter
# este módulo instalado garante que uma leitura manual de diagnóstico
# (ex.: `docker exec ... exiftool ficheiro.docx`) mostra o conteúdo real.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libimage-exiftool-perl \
        libarchive-zip-perl \
        ffmpeg \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && exiftool -ver \
    && ffmpeg -version

RUN groupadd --system filepad && useradd --system --gid filepad --home-dir /app --shell /usr/sbin/nologin filepad

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/public ./public
COPY package.json ./

RUN mkdir -p /app/data /app/uploads/quarantine /app/uploads/final \
    && chown -R filepad:filepad /app

USER filepad

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    UPLOADS_DIR=/app/uploads

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/health || exit 1

CMD ["node", "server/index.js"]
