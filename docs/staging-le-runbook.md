# Staging / pre-production ACME runbook (T4.7)

Two separate things live in this document, for two separate purposes:

1. **Pebble e2e** (`test/integration/pebble-e2e.sh`) -- the CI-repeatable
   harness. No real domain, no rate limits, runs in under a minute. This is
   what actually exercises the ACME flow on every change to it.
2. **Let's Encrypt staging** -- the pre-production sanity check you run
   once, by hand, against a real domain, before pointing a real deployment
   at real production Let's Encrypt. This is not automated and should not
   be: it needs real DNS delegation and burns real (if generous) staging
   rate limits.

Read section 2 only when you're about to go live with a real domain for
the first time, or after a change to the ACME client you want to sanity
check against a real (non-Pebble) server before trusting it in production.

## 1. Pebble e2e (CI / local, automated)

```sh
bash test/integration/pebble-e2e.sh
```

What it does, in order:

1. Brings up the normal compose stack plus `deploy/docker-compose.pebble.yml`
   -- adds `pebble` (Let's Encrypt's own ACME v2 test server) and
   `pebble-challtestsrv` (its companion fake-DNS + management API), and
   points `pluginhost` at them via the non-secret endpoint-override env
   vars `child-runner.ts` allowlists for passthrough into every spawned
   plugin (`WANFW_ACME_DIRECTORY_URL`, `WANFW_DNS01_RESOLVER`,
   `WANFW_CHALLTESTSRV_URL`, `NODE_TLS_REJECT_UNAUTHORIZED`). None of these
   are set in the real `docker-compose.yml`, so this passthrough is a
   no-op in production.
2. Trusts every built-in, including `dns-mock` -- a Pebble-only
   `dns-provider` plugin (T4.7) that answers `dns.apply` by calling
   `pebble-challtestsrv`'s `/set-txt` / `/clear-txt` HTTP API instead of a
   real DNS API. This is what Pebble's own DNS-01 validator actually
   queries (via its `-dnsserver` flag), so no real DNS or real domain
   ownership is needed anywhere in this flow.
3. Writes a framework doc binding `dnsProvider: dns-mock` and
   `certIssuer: cert-letsencrypt-dns01`, plus one service.
4. Waits for the RENEWAL stage (T4.6) to notice the exposed hostname has
   no cert yet and automatically invoke `cert.ensure` -- a real ACME v2
   account-creation, order, DNS-01 challenge, finalize, and download cycle
   against Pebble.
5. Asserts: the stored cert is a real PEM signed by Pebble's intermediate
   CA; the `_acme-challenge` TXT record was cleaned up from
   `pebble-challtestsrv` after issuance; forcing the stored cert's
   `storedAt` back past the 30-day renewal window (and clearing its
   `renewal-state.json` backoff) causes a **second** real automatic
   issuance (generation 2); the proxy's live `Caddyfile` (`wanfw_proxycfg`)
   references the new generation's real cert/key paths, not `tls internal`
   or a stale generation.

Runs in well under a minute; tears the whole stack down afterward
(`docker compose down -v`), same discipline as the other two integration
suites (`run.sh`, `m1-plugin-runtime.sh`).

### Not exercised here (by design)

- **TXT cleanup on the failure path.** T4.4's own unit tests
  (`cert-ensure.test.ts`) already assert the `try/finally` around every
  authorization unconditionally calls `dns.deleteRecord`, covering DNS
  propagation timeouts, an authorization going `invalid`, and an
  unexpected mid-validation exception. Pebble e2e proves the *live*
  success-path cleanup (step 5 above); deliberately triggering a live
  DNS-01 validation *failure* against Pebble (e.g. publishing a wrong TXT
  value on purpose) would mostly be re-confirming what those unit tests
  already prove more precisely and far faster.
- **The `shortlived` cert profile.** Pebble's own config
  (`test/config/pebble-config.json` inside the image) offers a 6-day
  `shortlived` profile alongside the 90-day `default` one, which would let
  a test observe several real renewal cycles in minutes instead of forcing
  one via a backdated `storedAt`. Not used here since ACME profile
  selection isn't implemented in `acme-client.ts`/`cert-ensure.ts` --
  `default` (90 days) is always requested, matching real production Let's
  Encrypt's only lifetime. Worth revisiting if the client ever needs
  configurable cert lifetimes for a reason unrelated to testing.

### Two genuinely new bugs this harness found (both fixed, both worth knowing about)

These aren't Pebble quirks -- they'd eventually bite in production too;
Pebble just made them observable in a minute instead of over months.

1. **`node:http` (not `https`) crashes under this sandbox's `prlimit --as`
   ceiling, but only from an ESM entrypoint.** Distinct from T4.2's
   `fetch()`/WASM finding (same underlying `WebAssembly.instantiate(): Out
   of memory` error, different trigger): `dns-mock`'s plain
   `node:http.request` to `pebble-challtestsrv` reliably crashed the
   spawned child, isolated by direct experimentation to "`http` (not
   `https`) + ESM `import` (not CJS `require`)" -- confirmed unrelated to
   the memMb ceiling itself (raising it to 2048MB made no difference).
   Fixed by rewriting `dns-mock`'s HTTP client as a hand-rolled minimal
   HTTP/1.1 request over a raw `node:net` socket (see the comment in
   `plugins/dns-mock/src/main.ts`), which never touches Node's HTTP client
   module at all. Any *future* plugin that talks to a plain-HTTP (not
   HTTPS) backend needs the same treatment -- `node:https` remains fine.
2. **Authorization reuse breaks a naive DNS-01 client.** RFC 8555 §7.1.4
   lets a server reuse an already-valid authorization for an identifier
   instead of issuing a fresh pending one; both Pebble (its own boot log:
   "attempt authz reuse for each identifier 50% of the time") and real
   production Let's Encrypt do this. `cert-ensure.ts` unconditionally
   POSTed a challenge response even when the fetched authorization was
   already `"valid"` -- a protocol violation Pebble was entitled to reject,
   which silently failed every *second* issuance for the same identifier
   (exactly what a renewal is). Fixed: skip straight past an
   already-`"valid"` authorization (no TXT record needed at all), covered
   by a new unit test (`cert-ensure.test.ts`, "an already-valid
   (server-reused) authorization skips DNS-01 entirely"). This would have
   silently broken every real renewal in production the first time Let's
   Encrypt happened to reuse an authorization -- found only because this
   harness actually forces a *second* real issuance for the same name.

## 2. Let's Encrypt staging (manual, real domain, pre-production only)

Do this once, by hand, before a real deployment's first production
issuance -- never in CI, never automated.

### Prerequisites

- A real domain you control, delegated to a real DNS provider with a
  working `dns-provider` plugin (`dns-namecheap` today).
- `wanfwctl secret set dns-namecheap/api-user` / `.../username` /
  `.../api-key` already set for that provider (§12.4) -- see
  `wanfwctl secret --help`.
- The real domain's DNS provider allowlists this host's current WAN IP for
  API access, if it requires that (Namecheap does; `dns-namecheap`'s own
  error message names the exact fix when it's missing).

### Point the stack at LE staging instead of production

LE staging (`https://acme-staging-v02.api.letsencrypt.org/directory`)
speaks the real protocol against real DNS, with real (generous) rate
limits and certs signed by a **staging root no browser trusts** -- exactly
the property that makes it safe to rehearse against: a mistake here can't
accidentally serve a browser-trusted cert for a domain issuance was never
authorized for.

Set on the `pluginhost` service (matching the same env var
`docker-compose.pebble.yml` uses for Pebble, just pointed at LE staging
instead -- do **not** add this to the real `docker-compose.yml`; pass it
as a one-off override for this manual run):

```sh
docker compose -f deploy/docker-compose.yml run --rm \
  -e WANFW_ACME_DIRECTORY_URL=https://acme-staging-v02.api.letsencrypt.org/directory \
  pluginhost
```

Or, for a longer-lived staging rehearsal, add a small override compose
file (same shape as `docker-compose.pebble.yml`) with just that one env
var on `pluginhost`, and bring the stack up with
`-f docker-compose.yml -f docker-compose.staging-le.yml`.

### Run it

1. Bring up the real stack (`docker compose up -d --build`) with the
   staging directory URL override above.
2. `./wanfwctl plugin trust --builtin-all --yes`.
3. Write a real framework doc: `domain` set to your real domain,
   `roles.dnsProvider: dns-namecheap`, `roles.certIssuer:
   cert-letsencrypt-dns01`.
4. Write a real service doc exposing a real subdomain of that domain.
5. Watch `docker logs -f wanfw-pluginhost` and `wanfwctl cert list` --
   issuance should complete within the same ~seconds-to-tens-of-seconds
   window as it does against Pebble, since LE staging has no artificial
   delay either.
6. Confirm via `openssl s_client -connect <host>:443 -servername <host>
   </dev/null 2>/dev/null | openssl x509 -noout -issuer` that the served
   cert's issuer is `(STAGING) ...` -- if it says anything else, something
   is misconfigured and pointed at production instead.
7. `wanfwctl cert rollback wildcard` and re-issue once more, to rehearse
   the rollback path against a real (if staging) CA before trusting it in
   production.

### Cutting over to real production

Only after a successful staging rehearsal: remove the
`WANFW_ACME_DIRECTORY_URL` override entirely (letting
`plugins/cert-letsencrypt-dns01/src/main.ts`'s own default,
`https://acme-v02.api.letsencrypt.org/directory`, take over), and re-run
the same framework/service docs against the real stack. Real production
Let's Encrypt has real rate limits (50 certs/registered domain/week as of
this writing -- check Let's Encrypt's own current published limits before
relying on a specific number) -- this is exactly why the staging rehearsal
above exists, so the first real production issuance is not also the first
time the whole flow has ever been exercised against a real, non-Pebble
ACME server.
