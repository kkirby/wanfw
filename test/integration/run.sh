#!/usr/bin/env bash
# Integration harness (T1.5): spec §12.5 negative assertions. Brings up the
# compose stack, runs assertion scripts inside each container via
# `docker exec`, tears down. Any failure aborts with a nonzero exit so CI
# fails loudly.
set -euo pipefail

cd "$(dirname "$0")/../../deploy"

FAILURES=0

pass() { echo "  [pass] $1"; }
fail() { echo "  [FAIL] $1"; FAILURES=$((FAILURES + 1)); }

# Runs a command inside a container; returns its exit code without letting
# `set -e` abort the whole script.
exec_in() {
  local container="$1"
  shift
  docker exec "$container" "$@"
}

echo "==> Bringing up the compose stack"
docker compose up -d --build

echo "==> Waiting for containers to settle"
sleep 5

echo "==> §12.5 assertion: tier1 cannot stat /var/run/docker.sock"
if exec_in wanfw-tier1 sh -c 'test -e /var/run/docker.sock' 2>/dev/null; then
  fail "tier1 can see /var/run/docker.sock"
else
  pass "tier1 cannot stat /var/run/docker.sock"
fi

echo "==> §12.5 assertion: tier1 cannot connect to the admin socket path"
if exec_in wanfw-tier1 sh -c 'test -e /run/wanfw-admin/admin.sock' 2>/dev/null; then
  fail "tier1 can see the admin socket path"
else
  pass "tier1 has no admin socket path"
fi

echo "==> §12.5 assertion: tier1 has no mount of wanfw_state / wanfw_secrets / wanfw_rpc_plugin"
TIER1_MOUNTS=$(docker inspect wanfw-tier1 --format '{{range .Mounts}}{{.Name}} {{end}}')
for forbidden in wanfw_wanfw_state wanfw_wanfw_secrets wanfw_wanfw_rpc_plugin; do
  if echo "$TIER1_MOUNTS" | grep -qw "$forbidden"; then
    fail "tier1 has volume $forbidden mounted"
  else
    pass "tier1 does not mount $forbidden"
  fi
done

echo "==> §12.5 assertion: pluginhost cannot stat the Docker socket"
if exec_in wanfw-pluginhost sh -c 'test -e /var/run/docker.sock' 2>/dev/null; then
  fail "pluginhost can see /var/run/docker.sock"
else
  pass "pluginhost cannot stat /var/run/docker.sock"
fi

echo "==> §12.5 assertion: pluginhost has no mount of wanfw_state / wanfw_secrets"
PLUGINHOST_MOUNTS=$(docker inspect wanfw-pluginhost --format '{{range .Mounts}}{{.Name}} {{end}}')
for forbidden in wanfw_wanfw_state wanfw_wanfw_secrets; do
  if echo "$PLUGINHOST_MOUNTS" | grep -qw "$forbidden"; then
    fail "pluginhost has volume $forbidden mounted"
  else
    pass "pluginhost does not mount $forbidden"
  fi
done

echo "==> §12.5 assertion: orchestrator's only network interface is loopback"
IFACES=$(exec_in wanfw-orchestrator sh -c 'ls /sys/class/net' 2>/dev/null || echo "UNREADABLE")
if [ "$IFACES" = "lo" ]; then
  pass "orchestrator network interfaces: lo only"
else
  fail "orchestrator has non-loopback interfaces: $IFACES"
fi

echo "==> §12.5 assertion: orchestrator only holder of /var/run/docker.sock among framework containers"
if exec_in wanfw-orchestrator sh -c 'test -S /var/run/docker.sock' 2>/dev/null; then
  pass "orchestrator holds /var/run/docker.sock"
else
  fail "orchestrator cannot see /var/run/docker.sock (expected the one holder)"
fi

echo "==> §12.5 assertion: orchestrator status/admin sockets both accept connections"
if exec_in wanfw-orchestrator curl -s --unix-socket /run/wanfw/status/orch-status.sock http://x/status >/dev/null 2>&1; then
  pass "status socket reachable"
else
  fail "status socket unreachable"
fi
if exec_in wanfw-orchestrator curl -s --unix-socket /run/wanfw-admin/admin.sock http://x/status >/dev/null 2>&1; then
  pass "admin socket reachable"
else
  fail "admin socket unreachable"
fi

echo "==> Tearing down the compose stack"
docker compose down -v

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "integration: $FAILURES assertion(s) failed"
  exit 1
fi
echo "integration: all §12.5 assertions passed"
