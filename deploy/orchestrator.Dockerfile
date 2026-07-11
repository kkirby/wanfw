# TODO(T6.3): pin digest
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY plugins ./plugins
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @wanfw/core-schemas... --filter @wanfw/orchestrator... build

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system wanfw && useradd --system --gid wanfw --home-dir /app --shell /usr/sbin/nologin wanfw
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data/state /data/secrets /data/desired /data/status /data/staging /data/bundles /data/certs /data/proxycfg \
      /run/wanfw/status /run/wanfw/plugin /run/wanfw-admin \
    && chown -R wanfw:wanfw /data /run/wanfw /run/wanfw-admin
ENV NODE_ENV=production
USER wanfw
WORKDIR /app/packages/orchestrator
CMD ["node", "dist/main.js"]
