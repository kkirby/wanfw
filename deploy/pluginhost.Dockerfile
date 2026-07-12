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
RUN pnpm --filter @wanfw/core-schemas... --filter @wanfw/pluginhost... --filter @wanfw/plugin-sdk... --filter @wanfw/plugin-deploy-docker... --filter @wanfw/plugin-network-bridge... --filter @wanfw/plugin-proxy-caddy... --filter @wanfw/plugin-dns-namecheap... build

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/*
# Two users defined per ADR-3's design (supervisor vs. spawned children as a
# distinct uid); dropping privilege from the supervisor to wanfw-plugin at
# spawn time requires the supervisor to hold CAP_SETUID/CAP_SETGID, which is
# real complexity ADR-3 itself flags as a rejected-alternative tradeoff.
# Deviation for T2.6 (recorded in PROGRESS.md): the supervisor runs as
# `wanfw` non-root and children currently inherit that same uid rather than
# `wanfw-plugin` -- no privileged parent, so no cross-uid separation yet.
# Revisit with T6.3 hardening (grant CAP_SETUID+CAP_SETGID and drop them
# again immediately after spawn, or move to a setuid helper).
RUN groupadd --system wanfw && useradd --system --gid wanfw --home-dir /app --shell /usr/sbin/nologin wanfw \
    && groupadd --system wanfw-plugin && useradd --system --gid wanfw-plugin --home-dir /app --shell /usr/sbin/nologin wanfw-plugin
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data/bundles /run/wanfw \
      /app/builtins/deploy-docker/dist /app/builtins/network-bridge/dist /app/builtins/proxy-caddy/dist /app/builtins/dns-namecheap/dist \
    && cp /app/plugins/deploy-docker/manifest.json /app/plugins/deploy-docker/config-schema.json /app/builtins/deploy-docker/ \
    && cp /app/plugins/deploy-docker/dist/main.js /app/plugins/deploy-docker/dist/plan.js /app/builtins/deploy-docker/dist/ \
    && cp /app/plugins/network-bridge/manifest.json /app/builtins/network-bridge/ \
    && cp /app/plugins/network-bridge/dist/main.js /app/plugins/network-bridge/dist/probe.js /app/plugins/network-bridge/dist/plan.js /app/builtins/network-bridge/dist/ \
    && cp /app/plugins/proxy-caddy/manifest.json /app/builtins/proxy-caddy/ \
    && cp /app/plugins/proxy-caddy/dist/main.js /app/plugins/proxy-caddy/dist/render.js /app/builtins/proxy-caddy/dist/ \
    && cp /app/plugins/dns-namecheap/manifest.json /app/builtins/dns-namecheap/ \
    && cp /app/plugins/dns-namecheap/dist/main.js /app/plugins/dns-namecheap/dist/apply.js /app/plugins/dns-namecheap/dist/namecheap-client.js /app/builtins/dns-namecheap/dist/ \
    && chown -R wanfw:wanfw /data /run/wanfw /app/builtins
ENV NODE_ENV=production
ENV WANFW_BUILTINS_DIR=/app/builtins
USER wanfw
WORKDIR /app/packages/pluginhost
CMD ["node", "dist/main.js"]
