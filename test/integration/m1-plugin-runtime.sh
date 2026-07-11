#!/usr/bin/env bash
# M1 plugin runtime acceptance (spec §15 M1): trusted echo invokes end to
# end; tampered bundle refused loudly with an audit entry; out-of-grant host
# call rejected; sleep task killed at wallMs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/fixtures/echo-plugin"
cd "$SCRIPT_DIR/../../deploy"

FAILURES=0
pass() { echo "  [pass] $1"; }
fail() { echo "  [FAIL] $1"; FAILURES=$((FAILURES + 1)); }

echo "==> Bringing up orchestrator + pluginhost"
docker compose up -d --build orchestrator pluginhost
sleep 3

echo "==> Staging the echo test fixture into wanfw_staging"
docker run --rm -v wanfw_wanfw_staging:/staging -v "$FIXTURE_DIR":/fixture:ro busybox \
  sh -c "mkdir -p /staging/echo-test && cp -r /fixture/* /staging/echo-test/"

PENDING_JSON=$(./wanfwctl plugin list --pending)
REAL_SHA=$(echo "$PENDING_JSON" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const j=JSON.parse(d); const b=j.staged.find(s=>s.manifest && s.manifest.id==='echo-test-fixture');
    if(!b){process.exit(1);} console.log(b.sha256);
  })")

echo "==> [1/4] Trusted echo invokes end to end"
./wanfwctl plugin trust "echo-test-fixture@${REAL_SHA}" --yes >/dev/null
INVOKE_OUT=$(./wanfwctl plugin invoke echo-test-fixture echo '{"hello":"world"}')
if echo "$INVOKE_OUT" | grep -q '"hello": "world"'; then
  pass "trusted echo invoke round-trips the input"
else
  fail "echo invoke did not round-trip: $INVOKE_OUT"
fi

echo "==> [2/4] Tampered bundle refused at load, loudly, with an audit entry"
docker run --rm -v wanfw_wanfw_bundles:/bundles busybox \
  sh -c "echo '// tampered' >> /bundles/${REAL_SHA}/dist/main.js"
TAMPER_OUT=$(./wanfwctl plugin invoke echo-test-fixture echo '{"hello":"world"}' 2>&1 || true)
if echo "$TAMPER_OUT" | grep -qi "hash mismatch"; then
  pass "tampered bundle refused with a hash-mismatch error"
else
  fail "tampered bundle was not refused: $TAMPER_OUT"
fi
AUDIT_OUT=$(./wanfwctl audit tail)
if echo "$AUDIT_OUT" | grep -q "plugin.invoke.refused"; then
  pass "tamper refusal produced an audit entry"
else
  fail "no plugin.invoke.refused audit entry found"
fi
VERIFY_OUT=$(./wanfwctl audit tail --verify)
if echo "$VERIFY_OUT" | grep -q "chain verified"; then
  pass "audit chain still verifies after the tamper-refusal entry"
else
  fail "audit chain verification failed: $VERIFY_OUT"
fi

echo "==> Re-staging and re-trusting a clean copy for the remaining checks"
docker run --rm -v wanfw_wanfw_staging:/staging -v "$FIXTURE_DIR":/fixture:ro busybox \
  sh -c "rm -rf /staging/echo-test-2 && mkdir -p /staging/echo-test-2 && cp -r /fixture/* /staging/echo-test-2/"
PENDING_JSON2=$(./wanfwctl plugin list --pending)
REAL_SHA2=$(echo "$PENDING_JSON2" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const j=JSON.parse(d); const b=j.staged.find(s=>s.dirName==='echo-test-2');
    if(!b){process.exit(1);} console.log(b.sha256);
  })")
./wanfwctl plugin untrust echo-test-fixture --yes >/dev/null
./wanfwctl plugin trust "echo-test-fixture@${REAL_SHA2}" --yes >/dev/null

echo "==> [3/4] Out-of-grant host call rejected"
GRANT_OUT=$(./wanfwctl plugin invoke echo-test-fixture attemptSecretsRead '{}')
if echo "$GRANT_OUT" | grep -q '"rejected": true'; then
  pass "unauthorized host API call was rejected"
else
  fail "unauthorized host call was NOT rejected: $GRANT_OUT"
fi

echo "==> [4/4] Sleep task killed at wallMs"
START=$(date +%s%3N 2>/dev/null || date +%s)
SLEEP_OUT=$(./wanfwctl plugin invoke echo-test-fixture sleep '{}' --wall-ms 500)
if echo "$SLEEP_OUT" | grep -q '"code": "timeout"'; then
  pass "sleep task was killed at the wall-clock timeout"
else
  fail "sleep task was not killed as expected: $SLEEP_OUT"
fi

echo "==> Tearing down"
docker compose down -v

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "M1 acceptance: $FAILURES check(s) failed"
  exit 1
fi
echo "M1 acceptance: all four checks passed"
