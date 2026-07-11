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
RUN pnpm --filter @wanfw/core-schemas... --filter @wanfw/pluginhost... --filter @wanfw/plugin-sdk... build

FROM base AS runtime
RUN groupadd --system wanfw && useradd --system --gid wanfw --home-dir /app --shell /usr/sbin/nologin wanfw \
    && groupadd --system wanfw-plugin && useradd --system --gid wanfw-plugin --home-dir /app --shell /usr/sbin/nologin wanfw-plugin
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data/bundles /run/wanfw && chown -R wanfw:wanfw /data /run/wanfw
ENV NODE_ENV=production
USER wanfw
WORKDIR /app/packages/pluginhost
CMD ["node", "dist/main.js"]
