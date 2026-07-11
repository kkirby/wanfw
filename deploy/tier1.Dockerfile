# TODO(T6.3): pin digest
# Placeholder image (T0.3): serves a plain Node http server. T1.4 replaces
# this with a Next.js standalone build (output: "standalone").
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS runtime
RUN groupadd --system wanfw && useradd --system --gid wanfw --home-dir /app --shell /usr/sbin/nologin wanfw
WORKDIR /app
COPY packages/tier1/src ./src
COPY packages/tier1/package.json ./
RUN mkdir -p /data/desired /data/staging /run/wanfw /data/state && chown -R wanfw:wanfw /app /data /run/wanfw
ENV NODE_ENV=production
ENV PORT=8443
USER wanfw
EXPOSE 8443
CMD ["node", "src/placeholder-server.mjs"]
