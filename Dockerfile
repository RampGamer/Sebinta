# syntax=docker/dockerfile:1

# ---- Stage 1: install Node dependencies (includes native build of better-sqlite3) ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public

# ---- Stage 2: final image, only the runtime it needs ----
FROM node:20-bookworm-slim
WORKDIR /app

# No metadata cleaning on the server — just curl for the healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system sebinta && useradd --system --gid sebinta --home-dir /app --shell /usr/sbin/nologin sebinta

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/public ./public
COPY package.json ./

RUN mkdir -p /app/data /app/uploads/quarantine /app/uploads/final \
    && chown -R sebinta:sebinta /app

USER sebinta

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    UPLOADS_DIR=/app/uploads

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/health || exit 1

CMD ["node", "server/index.js"]
