# T6.3: base image pinned by digest (node:22-bookworm-slim); re-resolve and bump when intentionally upgrading Node.
FROM node@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY plugins ./plugins
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @wanfw/core-schemas... --filter @wanfw/orchestrator... --filter @wanfw/wanfwctl... build

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends curl gosu \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system wanfw && useradd --system --gid wanfw --home-dir /app --shell /usr/sbin/nologin wanfw
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data/state /data/secrets /data/desired /data/status /data/staging /data/bundles /data/certs /data/proxycfg \
      /run/wanfw/status /run/wanfw/plugin /run/wanfw-admin \
    && chown -R wanfw:wanfw /data /run/wanfw /run/wanfw-admin
RUN printf '#!/bin/sh\nexec node /app/packages/wanfwctl/dist/main.js "$@"\n' > /usr/local/bin/wanfwctl-inner \
    && chmod +x /usr/local/bin/wanfwctl-inner
COPY deploy/orchestrator-entrypoint.sh /usr/local/bin/orchestrator-entrypoint.sh
RUN chmod +x /usr/local/bin/orchestrator-entrypoint.sh
ENV NODE_ENV=production
WORKDIR /app/packages/orchestrator
ENTRYPOINT ["/usr/local/bin/orchestrator-entrypoint.sh"]
CMD ["node", "dist/main.js"]
