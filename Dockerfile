# ---------- build stage ----------
FROM node:20-slim AS builder

WORKDIR /app

# better-sqlite3 needs build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:20-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

RUN mkdir -p /app/data /app/logs

VOLUME ["/app/data", "/app/logs"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
