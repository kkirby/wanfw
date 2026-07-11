#!/usr/bin/env bash
# wanfw install stub (T0.3). Full wizard handoff lands in T5.3 (wanfwctl init).
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Pulling/building wanfw images"
docker compose -f docker-compose.yml pull --ignore-buildable 2>/dev/null || true
docker compose -f docker-compose.yml build

echo "==> Starting the wanfw stack"
docker compose -f docker-compose.yml up -d

cat <<'EOF'

wanfw stack is up.

Next step: run the init wizard to configure your domain, DNS provider, and
proxy network mode:

    ./wanfwctl init

(wanfwctl init ships in T5.3; until then this stack runs framework
placeholders only.)
EOF
