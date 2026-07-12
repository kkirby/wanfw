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
ENV NEXT_TELEMETRY_DISABLED=1
# next build's page-data collection imports lib/session-db.ts at module load
# (it opens the sqlite file), so it needs a writable path during the build
# itself; the real path is set at runtime via docker-compose environment.
ENV WANFW_TIER1STATE_DB=/tmp/build-tier1.sqlite3
RUN pnpm --filter @wanfw/tier1... build

FROM base AS runtime
RUN groupadd --system wanfw && useradd --system --gid wanfw --home-dir /app --shell /usr/sbin/nologin wanfw
WORKDIR /app
COPY --from=build /app/packages/tier1/.next/standalone ./
COPY --from=build /app/packages/tier1/.next/static ./packages/tier1/.next/static
RUN mkdir -p /data/desired /data/staging /data/state /run/wanfw \
    && chown -R wanfw:wanfw /app /data /run/wanfw
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8443
ENV HOSTNAME=0.0.0.0
USER wanfw
WORKDIR /app/packages/tier1
EXPOSE 8443
CMD ["node", "server.js"]
