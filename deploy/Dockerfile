# Build from the repository root:
#   docker build -f deploy/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) .

FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
# Dependency manifests first, so the install layer is cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/storage-node/package.json packages/storage-node/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
RUN pnpm --filter @dk/web build && pnpm --filter @dk/server build

# The server and CLI are bundled into single files, so the runtime image needs
# no node_modules at all: just Node, two scripts and the static web app.
FROM node:24-alpine
ARG GIT_SHA=dev
LABEL org.opencontainers.image.source=https://github.com/FelixLabsDev/DownloadKnowledge
ENV NODE_ENV=production \
    GIT_SHA=$GIT_SHA \
    PORT=8787 \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    NODE_OPTIONS="--disable-warning=ExperimentalWarning --max-old-space-size=160"
WORKDIR /app
COPY --from=build /repo/apps/server/dist/main.js /repo/apps/server/dist/cli.js ./
COPY --from=build /repo/apps/web/dist ./web
RUN printf '#!/bin/sh\nexec node /app/cli.js "$@"\n' > /usr/local/bin/dk && chmod +x /usr/local/bin/dk \
 && mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "/app/main.js"]
