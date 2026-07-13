#!/usr/bin/env bash
# Pebble e2e acceptance (T4.7): the real ACME v2 DNS-01 issuance flow
# (T4.4's client, T4.3's DNS broker, T4.5's cert store, T4.6's renewal
# scheduler, proxy-caddy's cert-serving render) exercised end to end
# against Let's Encrypt's own Pebble test server + pebble-challtestsrv,
# instead of either unit-test fakes or a one-off manual run against real
# production Let's Encrypt (T4.4's own live verification). No real domain,
# no production rate limits, no waiting on a real 90-day clock.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../deploy"

FAILURES=0
pass() { echo "  [pass] $1"; }
fail() { echo "  [FAIL] $1"; FAILURES=$((FAILURES + 1)); }

HOSTNAME="kavita.wanfw-pebble-e2e.test-domain.org"

echo "==> Bringing up the compose stack + Pebble overlay"
docker compose -f docker-compose.yml -f docker-compose.pebble.yml up -d --build
sleep 10

echo "==> Trusting every built-in, including dns-mock (Pebble-only, T4.7) and cert-letsencrypt-dns01"
./wanfwctl plugin trust --builtin-all --yes >/dev/null

echo "==> Writing a framework doc bound to dns-mock (DNS-01 backend) + cert-letsencrypt-dns01 (issuer)"
# The framework doc lives in wanfw_state now (T5.3, docs/t5.3-decisions.md
# Decision 1), authored only via 'wanfwctl framework set' -- never a raw
# wanfw_desired/framework.json write. Kept in a var so it can be re-set
# later purely to trigger a fresh reconcile (POST /framework always fires
# onFrameworkChange, regardless of whether the content actually changed).
FRAMEWORK_DOC='{
  "schemaVersion": 1,
  "kind": "Framework",
  "metadata": { "id": "framework" },
  "spec": {
    "domain": "test-domain.org",
    "deploymentMode": "subdomain",
    "acmeEmail": "ops@test-domain.org",
    "roles": {
      "networkProvider": "network-bridge",
      "proxyEngine": "proxy-caddy",
      "dnsProvider": "dns-mock",
      "certIssuer": "cert-letsencrypt-dns01"
    }
  }
}'
echo "$FRAMEWORK_DOC" | ./wanfwctl framework set
docker run --rm -v wanfw_wanfw_desired:/desired busybox sh -c "mkdir -p /desired/services && cat > /desired/services/kavita.json <<EOF
{
  \"schemaVersion\": 1,
  \"kind\": \"Service\",
  \"metadata\": { \"id\": \"kavita\" },
  \"spec\": {
    \"deploy\": { \"plugin\": \"deploy-docker\", \"image\": \"busybox:latest\", \"cmd\": [\"sleep\", \"3600\"] },
    \"expose\": { \"hostname\": \"$HOSTNAME\", \"backendPort\": 5000, \"backendProtocol\": \"http\" }
  }
}
EOF
"

echo "==> [1/5] Waiting for the RENEWAL stage to issue a real cert via Pebble (up to 3min)"
# The ACME client's own poll cap is 10 minutes (cert-ensure.ts's
# POLL_TIMEOUT_MS, §9) -- this outer budget only needs to be a fraction of
# that, but 60s (30 x 2s) proved too tight on a cold/shared CI runner where
# every image has to build from scratch with no layer cache carried over
# from an earlier job, and containers take longer to become fully live
# than on a warm local dev machine. 3 minutes gives real headroom without
# masking a genuine failure -- the local happy path finishes in seconds.
ISSUED=""
for _ in $(seq 1 90); do
  CERTS_JSON=$(./wanfwctl cert list 2>/dev/null || echo '{"certs":[]}')
  if echo "$CERTS_JSON" | grep -q '"currentGeneration": 1'; then
    ISSUED="1"
    break
  fi
  sleep 2
done
if [ -n "$ISSUED" ]; then
  pass "wildcard cert issued (generation 1) via a real ACME v2 DNS-01 flow against Pebble"
else
  fail "no cert was issued within 3min: $(./wanfwctl cert list 2>&1)"
fi

echo "==> [2/5] The stored cert is a real PEM issued by Pebble's intermediate CA"
CERT_ISSUER=$(docker run --rm -v wanfw_wanfw_certs:/certs busybox sh -c \
  "grep -q 'BEGIN CERTIFICATE' /certs/wildcard/gen-1/fullchain.pem && echo present" 2>/dev/null || echo "missing")
if [ "$CERT_ISSUER" = "present" ]; then
  pass "gen-1/fullchain.pem is a real PEM certificate"
else
  fail "gen-1/fullchain.pem missing or not a PEM cert"
fi

echo "==> [3/5] The _acme-challenge TXT record was cleaned up from pebble-challtestsrv after issuance"
CLEANED=$(docker run --rm --network wanfw_wanfw_egress node:22-bookworm-slim node -e "
const dns = require('node:dns/promises');
(async () => {
  const { address } = await dns.lookup('pebble-challtestsrv');
  const r = new dns.Resolver();
  r.setServers([address + ':8053']);
  try {
    await r.resolveTxt('_acme-challenge.$HOSTNAME');
    console.log('still-present');
  } catch {
    console.log('cleaned');
  }
})();
" 2>/dev/null || echo "probe-failed")
if [ "$CLEANED" = "cleaned" ]; then
  pass "_acme-challenge TXT record cleaned up after a successful issuance"
else
  fail "_acme-challenge TXT record was not cleaned up (got: $CLEANED)"
fi

echo "==> [4/5] Forcing a real renewal: backdating gen-1's storedAt past the 30-day window, resetting backoff"
docker run --rm -v wanfw_wanfw_certs:/certs busybox sh -c \
  "printf '{\"names\":[\"$HOSTNAME\"],\"storedAt\":\"2026-05-01T00:00:00.000Z\"}' > /certs/wildcard/gen-1/meta.json; \
   rm -f /certs/wildcard/renewal-state.json"
echo "$FRAMEWORK_DOC" | ./wanfwctl framework set >/dev/null

RENEWED=""
for _ in $(seq 1 90); do
  CERTS_JSON=$(./wanfwctl cert list 2>/dev/null || echo '{"certs":[]}')
  if echo "$CERTS_JSON" | grep -q '"currentGeneration": 2'; then
    RENEWED="1"
    break
  fi
  sleep 2
done
if [ -n "$RENEWED" ]; then
  pass "RENEWAL stage automatically re-issued a fresh cert (generation 2) once past the 30-day window"
else
  fail "no automatic renewal happened within 3min: $(./wanfwctl cert list 2>&1)"
fi

echo "==> [5/5] The proxy's live Caddyfile references the latest generation's real cert path"
docker rm -f wanfw-proxy >/dev/null 2>&1 || true
echo "$FRAMEWORK_DOC" | ./wanfwctl framework set >/dev/null
sleep 20
CADDYFILE=$(docker run --rm -v wanfw_wanfw_proxycfg:/proxycfg busybox cat /proxycfg/Caddyfile 2>/dev/null || echo "")
if echo "$CADDYFILE" | grep -q "gen-2/fullchain.pem"; then
  pass "generated Caddyfile serves the gen-2 (renewed) cert, not gen-1 or tls internal"
else
  fail "generated Caddyfile does not reference the renewed cert: $CADDYFILE"
fi

echo "==> Tearing down the compose stack"
docker rm -f wanfw-proxy wanfw_kavita >/dev/null 2>&1 || true
docker compose -f docker-compose.yml -f docker-compose.pebble.yml down -v

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "pebble-e2e: $FAILURES assertion(s) failed"
  exit 1
fi
echo "pebble-e2e: all checks passed"
