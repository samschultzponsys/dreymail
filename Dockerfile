# syntax=docker/dockerfile:1
# Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
# Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
# Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
# Modified by samschultzponsys, 2026-11-13: version and changelog at the bottom left; first name only by default.

# ---- base: runtime OS plus the entrypoint that drops to PUID:PGID ------------
# Its own stage so the entrypoint tests can build it without compiling the app.
FROM node:22-alpine AS base
RUN apk add --no-cache su-exec
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/dreymail-entrypoint
ENTRYPOINT ["dreymail-entrypoint"]

# ---- build: install all dependencies and compile server + web client -------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY shared ./shared
COPY server/src ./server/src
COPY web ./web
RUN npm run build

# ---- prod-deps: runtime dependencies only ----------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime ---------------------------------------------------------------
FROM base
ENV NODE_ENV=production \
    PORT=8080 \
    DREYMAIL_DATA_DIR=/data \
    DREYMAIL_WEB_DIR=/app/dist/web
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json CHANGES.md ./
RUN mkdir -p /data && chown node:node /data
# Starts as root only long enough for the entrypoint to chown /data, then runs as PUID:PGID
# (default 1000:1000, the `node` user).
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/server/src/index.js"]
