# wanfw MVP Implementation Plan

Agent execution plan for `wanfw-mvp-design-spec.md` v0.1. This document controls **task order, stack choices, and acceptance gates**. The design spec controls **behavior, security semantics, and data shapes**. When this plan and the spec conflict on behavior, the spec wins; when they conflict on stack or file layout, this plan wins (it encodes deliberate operator decisions).

---

## 0. How to use this document (agent instructions)

1. Commit the design spec verbatim to `docs/design-spec.md` before writing any code. All `Spec:` references below point at its section numbers.
2. Work tasks in order within a phase. Tasks list explicit dependencies; do not start a task whose dependencies are incomplete.
3. Each task ends with "Done when" criteria. Do not proceed until they pass. Each phase ends with a **Gate**; run the full gate checklist before starting the next phase.
4. Maintain `docs/PROGRESS.md`: one line per task (id, status, date, deviations). If you must deviate from this plan or the spec, record it there with rationale before doing it.
5. Commit per task, message prefixed with the task id (`T2.6: pluginhost supervisor`).
6. Security-relevant tasks (anything touching trust, grants, approvals, sockets, secrets) must include their negative tests in the same task. A security feature without its failure-path test is not done.
7. Never "temporarily" violate an invariant from §2 below to make something easier to test. Build the test harness around the invariant instead.

---

## 1. Binding stack decisions (deltas and pins vs spec §14)

| Concern | Spec §14 says | This plan (binding) |
|---|---|---|
| Tier 1 | Fastify BFFE + React/Vite, rjsf or hand-rolled forms | **Next.js (App Router, SSR, server actions)**, single package `packages/tier1`. **Mantine** for UI. Hand-rolled schema-driven form renderer over Ajv (no rjsf). |
| Tier 1 packages | `tier1-api/` + `tier1-ui/` | Collapsed into one `tier1/` package. |
| Orchestrator | Plain TS, no web framework | Unchanged. `node:http` servers bound to Unix socket paths, tiny hand-rolled JSON route dispatcher. No NestJS, no framework. |
| Pluginhost | Plain TS supervisor | Unchanged. |
| CLI | Plain TS, commander | Unchanged. |
| Everything else | dockerode, better-sqlite3, ajv (2020-12), chokidar, Ed25519 via node:crypto, caddy 2.x pinned digest, pnpm monorepo, Node 22 LTS, ESM, strict tsconfig | Unchanged. |

Additional pinned choices (make these without revisiting):

- **Base images:** `node:22-bookworm-slim` for all three framework images. Rationale: `better-sqlite3` and argon2 are native modules; glibc prebuilds avoid musl build pain. Do not use alpine.
- **Password hashing:** `@node-rs/argon2` (argon2id, prebuilt binaries).
- **Tier 1 sessions:** server-side sessions in a SQLite table inside `wanfw_tier1state` (spec §10.2 requires the session store in that volume). Cookie is an opaque session id: HttpOnly, SameSite=Strict, Path=/. No JWT, no remember-me.
- **Tier 1 to orchestrator transport:** small client lib using `node:http.request` with `socketPath` pointed at `orch-status.sock`. Used only from server components, server actions, and route handlers. Never from client code.
- **Status socket and admin socket protocol:** HTTP over Unix domain socket, JSON bodies. Simple, curl-debuggable via `docker exec`.
- **Plugin socket and child stdio protocol:** JSON-RPC 2.0, newline-delimited JSON framing (NDJSON), bidirectional over one persistent connection. Spec §6.5 mandates JSON-RPC 2.0; framing is our choice, so document it in `docs/plugin-authoring.md`.
- **Next.js:** `output: "standalone"`, telemetry disabled, App Router only, TypeScript strict. All mutations via server actions except plugin bundle upload (streaming route handler, see T2.10).
- **Testing:** vitest for unit tests in every package; integration tests are shell + vitest drivers around `docker compose` (see T1.5); Pebble for ACME e2e (spec §14).

### Interpretations this plan adds (veto before implementation if wrong)

The spec's own veto-list style, extended for gaps the spec leaves open:

1. **Socket listener direction:** the orchestrator listens on both `orch-status.sock` and `orch-plugin.sock`; tier1 and pluginhost dial in. Pluginhost holds one persistent connection and receives `invoke` jobs over it (server-to-client requests are legal in JSON-RPC 2.0 bidirectional usage).
2. **Built-in bundle discovery:** built-ins ship in the pluginhost image (spec ADR-3). The orchestrator cannot read that filesystem, so the pluginhost exposes a control RPC `builtins.list` returning `{id, version, manifest, sha256}` per bundle, and `builtins.read(id)` streaming the bundle bytes so the orchestrator can copy trusted built-ins into `wanfw_bundles` exactly like third-party bundles. Trust flow is otherwise identical (spec ADR-5).
3. **Network probe mediation:** plugins may never call Docker (ADR-4), but `network-provider.probe` needs host facts. The orchestrator assembles `ProbeContext` (Docker info, interface list as visible to Docker, host port bindings currently claimed by containers, `framework.spec.network` hints) and offers one core-mediated helper during probe tasks only: `net.probeNetwork(mode, parent)` which creates and immediately deletes a throwaway Docker network under core authority, journaled. This keeps probes honest without granting plugins Docker access.
4. **WAN IP detection** (spec §8.3 "pluginhost helper"): implemented as a pluginhost control RPC `helper.wanIp(url)` (default endpoint configurable in the framework doc), not as a plugin. Only callable by the orchestrator, used by the wizard and `doctor`.
5. **CSP vs Mantine:** spec §10.3 requires CSP without unsafe-inline. Scripts: strict, nonce-based via Next.js middleware (`script-src 'nonce-…' 'strict-dynamic'`). Styles: Mantine sets CSS variables through element `style` attributes; if a fully strict `style-src` breaks it, allow `style-src-attr 'unsafe-inline'` while keeping `style-src-elem` strict, and document the concession in `docs/threat-model.md`. Do not silently add blanket `unsafe-inline`.
6. **Read-only rootfs for tier1:** Next.js standalone runs read-only with tmpfs at `/tmp` and at the Next cache dir (`/app/.next/cache`). Incremental cache is not needed; all data pages are dynamic.
7. **Exit codes** for `wanfwctl` (spec §11 requires stable, documented): `0` ok, `1` internal error, `2` usage, `3` pending approval exists, `4` validation failure, `5` not found, `6` refused (trust/hash mismatch), `7` daemon unreachable. Document in CLI `--help` and `docs/operator-guide.md`.

---

## 2. Non-negotiable invariants (standing guardrails for every task)

Distilled from spec §2, §3, ADR-3 through ADR-9, §12. Re-read this list before starting any task that touches containers, sockets, or state.

1. Only `wanfw-orchestrator` mounts `/var/run/docker.sock`. No other container, ever, including in test fixtures and compose overlays.
2. `wanfw_state` and `wanfw_secrets` mount only into the orchestrator.
3. Tier 1 never mounts `wanfw_rpc_plugin`. The status socket and plugin socket live on **separate volumes** (spec §2.2 explains why; keep it).
4. The status socket exposes **zero mutating endpoints**. Reads, pure validation, and a nudge only. A unit test asserts the route table against an allowlist (T1.2); keep that test green forever.
5. Every security mutation (trust, untrust, grant, revoke, approve, secret set/unset, key ops, strictApprovals) happens only on `admin.sock`, which lives at a path inside the orchestrator container that is on no shared volume.
6. Tier 1 renders copyable `wanfwctl` commands for those mutations. It never implements them. No approve buttons, no secret value inputs (spec ADR-6, veto item 5).
7. Docker-touching plugins are declarative: they emit plans; the orchestrator validates field-by-field (§12.1) and executes primitives itself. No raw Docker methods in the host API, ever.
8. The orchestrator's grant store is authoritative for every host API call. The `grants` array in an invocation payload is informational only.
9. Powerful plans execute only against an approval record matching the powerful projection hash (§12.2). Nothing is blocked outright; catastrophic content gets the banner (ADR-4).
10. Desired state flows one way: tier1 writes `wanfw_desired`, orchestrator reads. The orchestrator never writes that volume (migration write-back goes through the `needsPersist` flag, §5.6).
11. All document writes anywhere are atomic: temp file + `rename(2)`. One shared utility, used everywhere.
12. Every Docker object the framework creates carries the ADR-9 labels; reconciliation and GC see labeled objects only.
13. Secrets: 0700 dirs, 0600 files, injected by value at invoke time, never mounted into pluginhost, never transiting tier1.
14. Framework containers: non-root, `no-new-privileges`, `cap_drop: [ALL]`, read-only rootfs plus tmpfs where feasible, pinned digests in the published compose file (§12.6).
15. The working name appears in exactly one constants module (spec preamble).

---

## 3. Repository layout

```
/packages
  core-schemas/        # envelope, framework, service, expose schemas; capability
                       # taxonomy; canonical JSON + projection utils; atomic-write util
  orchestrator/        # reconciler, capability engine, trust store, sockets, wanfwctl-inner
  pluginhost/          # supervisor: bundle verify, child spawn, RPC bridge
  plugin-sdk/          # @wanfw/plugin-sdk
  tier1/               # Next.js app (SSR + server actions + Mantine)
  wanfwctl/            # commander CLI (built into orchestrator image) + host wrapper script
/plugins
  deploy-docker/
  network-bridge/
  network-macvlan/
  proxy-caddy/
  cert-letsencrypt-dns01/
  dns-namecheap/
/deploy
  docker-compose.yml
  install.sh
/docs
  design-spec.md  operator-guide.md  threat-model.md  plugin-authoring.md  PROGRESS.md
/test
  integration/         # compose-level assertions (§12.5), e2e with Pebble + mock DNS
```

---

## Phase 0: Scaffold

### T0.1 Monorepo bootstrap
- **Depends:** none. **Spec:** §14.
- **Build:** pnpm workspaces per layout above; root `tsconfig.base.json` (strict, ESM, `module: NodeNext`, target ES2022); vitest workspace config; `engines.node >= 22`; per-package build scripts; placeholder entrypoints so `pnpm -r build` succeeds.
- **Done when:** `pnpm -r build` and `pnpm -r test` pass across all empty packages.

### T0.2 core-schemas package
- **Depends:** T0.1. **Spec:** §5.2, §5.3, §5.4, §12.1, §12.2, §6.6.
- **Build:** JSON Schemas (draft 2020-12) for the document envelope, Framework doc, Service doc core (`spec.expose` full; `spec.deploy` left as an open anchor for the bound deploy plugin's schema), PluginConfig envelope. Capability taxonomy constants: every capability id from §12.1 and §6.6, with tier (`baseline` | `powerful`) and scope shape. Canonical JSON serializer (sorted keys, sorted arrays where the spec says sorted). Powerful projection function per §12.2 with fixed test vectors (hand-computed hashes committed as fixtures). Atomic-write utility (temp + rename, fsync). Name constants module.
- **Done when:** unit tests cover schema validity, projection vectors, canonicalization edge cases (key order, array order, unicode), atomic write.

### T0.3 Compose stack + Dockerfiles
- **Depends:** T0.1. **Spec:** Appendix A (normative for mounts/isolation), §2.1, §2.2, §12.6.
- **Build:** `deploy/docker-compose.yml` matching Appendix A exactly for mounts, networks, `network_mode: none` on the orchestrator, security opts. Three Dockerfiles: tier1 (Next standalone, non-root, tmpfs plan per interpretation 6), orchestrator (includes `wanfwctl-inner`), pluginhost (will include built-in bundles from Phase 2 on). `install.sh` stub (pull, up, print init instructions). Digest pinning deferred to T6.3; use tags until then but leave `# TODO(T6.3): pin digest` markers.
- **Done when:** `docker compose config` validates; all three images build; stack starts and stays up with placeholder processes.

### T0.4 CI
- **Depends:** T0.1 to T0.3.
- **Build:** pipeline with jobs: install + build, unit tests, image build, integration job that runs the T1.5 harness (initially a no-op script committed now so the wiring exists).
- **Done when:** CI green on main.

**Gate P0:** all of the above; PROGRESS.md started.

---

## Phase 1: M0 skeleton (spec §15 M0)

### T1.1 Orchestrator process skeleton
- **Depends:** T0.2, T0.3. **Spec:** §2.2, §2.3, §7 (triggers only), §13 (logging).
- **Build:** entrypoint that: initializes `/data/state` dirs, structured JSON logging to stdout, tolerates a missing framework doc (pre-init state), runs a heartbeat loop writing `wanfw_status/framework.json` atomically every 10s with `{phase, ts, version}`. Two HTTP-over-UDS servers: status socket at `/run/wanfw/status/orch-status.sock` (shared volume), admin socket at `/run/wanfw-admin/admin.sock` (container-private path, mode 0700 dir). Unlink stale sockets on boot. Tiny route dispatcher (method + path to handler, JSON in/out, structured errors).
- **Done when:** container boots, heartbeat file updates, both sockets accept connections (verified via `docker exec` curl `--unix-socket`).

### T1.2 Status socket read-only API
- **Depends:** T1.1. **Spec:** §2.2 rules.
- **Build:** endpoints: `GET /status`, `GET /status/services/:id`, `GET /schema` (404 until T3.2), `GET /approvals/pending` (empty until T3.7), `POST /validate` (returns 501 until T3.2; must be a pure function when implemented), `POST /nudge`. **Allowlist test:** a unit test that enumerates the registered routes and fails if any route outside this fixed set exists. This test is the enforcement of invariant 4; never weaken it.
- **Done when:** endpoints respond; allowlist test passes.

### T1.3 wanfwctl skeleton
- **Depends:** T1.1. **Spec:** §2.3, §11.
- **Build:** `packages/wanfwctl` producing `wanfwctl-inner` (commander) that speaks HTTP to `admin.sock`; host wrapper shell script `wanfwctl` that runs `docker exec -i wanfw-orchestrator wanfwctl-inner "$@"`. Implement `status` end to end (admin socket `GET /status`). Exit-code table per interpretation 7, encoded as constants and asserted in tests.
- **Done when:** `./wanfwctl status` from the host prints orchestrator heartbeat state; exit codes verified for ok / unreachable / usage.

### T1.4 Tier 1 Next.js skeleton with auth
- **Depends:** T0.3. **Spec:** §10.1 (dashboard only), §10.2, §10.3 partially, §2.2.
- **Build:**
  - Next.js App Router app in `packages/tier1`: `output: "standalone"`, Mantine (`MantineProvider`, `ColorSchemeScript` in root layout, `postcss-preset-mantine`), base app shell (nav: Dashboard, Services, Plugins, Approvals, Secrets, Setup).
  - UDS client lib `lib/orch.ts` (invariant: server-side only; add an `import "server-only"` guard).
  - Auth: login page; server action verifying argon2id hash read from `wanfw_tier1state` (hash is written later by `wanfwctl init`, T5.3; until then support a dev bootstrap script that writes one); sessions table (SQLite, better-sqlite3) in the same volume; opaque session cookie per §1 choices; middleware guarding everything except `/login` and static assets; logout action; login rate limiting (per-IP sliding window persisted in the session DB); CSRF posture documented: server actions rely on Next's Origin/Host enforcement, any non-action mutation route (only the T2.10 upload) carries a session-bound CSRF token.
  - Dashboard page: server component fetching `GET /status` over UDS; lightweight client polling (route handler `GET /api/status` proxying the socket, poll every 3 to 5s).
- **Done when:** login works against a seeded hash, wrong password is rate-limited, dashboard renders heartbeat status, `pnpm build` produces a standalone bundle that runs with read-only rootfs + the two tmpfs mounts.

### T1.5 Integration harness + §12.5 negative assertions
- **Depends:** T1.1 to T1.4. **Spec:** §12.5, §15 M0.
- **Build:** `test/integration/` harness: brings the compose stack up, executes assertion scripts inside each container via `docker exec`, tears down. Assertions: tier1 cannot stat `/var/run/docker.sock`; tier1 cannot connect to the admin socket path; tier1 has no mount of `wanfw_state`, `wanfw_secrets`, or `wanfw_rpc_plugin`; pluginhost cannot stat the Docker socket; orchestrator's only network interface is loopback (read `/sys/class/net`); all shared-volume permissions match §2.2. Wire into CI.
- **Done when:** all assertions pass in CI; deliberately breaking one (e.g. temporarily adding a mount in a scratch branch) makes CI fail.

**Gate M0 (spec §15):** compose stack boots (tier1 hello + login, orchestrator heartbeat, pluginhost idle placeholder), `wanfwctl status` round-trips, §12.5 negative assertions pass in CI.

---

## Phase 2: M1 plugin runtime + trust (spec §15 M1)

### T2.1 SQLite state store
- **Depends:** T1.1. **Spec:** §2.2 (`wanfw_state`), ADR-5, §12.3.
- **Build:** better-sqlite3, WAL mode, migration runner. Tables: `trust_records(plugin_id, version, sha256, granted_caps_json, sig, created_at)`, `grants(plugin_id, cap, scope_json, sig, created_at, revoked_at)`, `approvals(projection_hash, service_id, human_rendering, sig, approved_at, revoked_at)`, `ipam_ranges` / `ipam_allocations`, `plugin_kv(plugin_id, key, value)`, `journal(plan_id, step, payload_json, result, ts)`, `meta` (key custody, audit checkpoints).
- **Done when:** CRUD + migration tests pass; DB file lives under `wanfw_state` 0600.

### T2.2 Ed25519 signing key
- **Depends:** T2.1. **Spec:** ADR-5.
- **Build:** first-boot keygen (`node:crypto`), PKCS8 at 0600 in `wanfw_state`; sign/verify helpers over canonical JSON; `wanfwctl key show` (public), `key rotate` (re-signs all live trust/grant/approval records atomically), `key import`.
- **Done when:** rotate re-signs and old signatures verify as stale; import replaces custody; tests cover both.

### T2.3 Audit log
- **Depends:** T2.2. **Spec:** §12.3.
- **Build:** append-only JSONL in `wanfw_state`, `prevHash` chain, Ed25519 checkpoint signature every 100 entries and on every security-relevant entry (trust, grant, approve, key op, powerful execute, secret set). Every admin-socket mutation writes an entry. `wanfwctl audit tail [--verify]` recomputes the chain and checks signatures.
- **Done when:** `--verify` passes on a clean log and fails loudly when a byte in a historical entry is flipped (test does exactly that).

### T2.4 Manifest schema + loader
- **Depends:** T0.2. **Spec:** §6.2, §6.3 notes.
- **Build:** manifest JSON Schema per §6.2 including `enforcement: "declared"`; `frameworkApi` semver compatibility check; scope-template resolution (`${framework.domain}`) executed at grant time, with the **resolved** scope recorded and signed; loader that validates and normalizes a bundle directory.
- **Done when:** fixture manifests (valid, invalid, template-bearing) pass/fail correctly.

### T2.5 Trust flow
- **Depends:** T2.1 to T2.4, T2.6 (for `builtins.list`). **Spec:** ADR-5, §6.4, §11.
- **Build:** staged-bundle listing (hash `wanfw_staging` contents on demand); `wanfwctl plugin list [--pending]`, `plugin show <id>`; `plugin trust <id>@<hash>`: display manifest + every capability request with reason, confirm interactively, pin hash, copy bundle into `wanfw_bundles/<sha256>/`, record trust + grants (resolved scopes), sign, audit. `--builtin-all`: pull manifests/hashes via pluginhost `builtins.list`, display each, one confirmation, copy via `builtins.read`. `plugin untrust <id>` revokes; subsequent plans referencing it must fail validation (asserted later in T3.6 tests). Upgrade path: trusting a new hash for an existing id shows a **diff of capability requests** vs the currently trusted version.
- **Done when:** trust, untrust, builtin-all, and upgrade-diff paths all covered by tests; staging a different bundle after trust changes nothing (hash no longer matches; test proves it).

### T2.6 Pluginhost supervisor
- **Depends:** T0.3. **Spec:** ADR-3, §6.5.
- **Build:** dials `orch-plugin.sock`, maintains persistent NDJSON JSON-RPC connection, serves control RPCs (`builtins.list`, `builtins.read`, `helper.wanIp` stub for now) and handles `invoke` jobs: verify bundle sha256 against the job's pinned hash (read from `wanfw_bundles` ro, or built-in path); spawn one child per invocation: `prlimit --as=<memMb> --cpu=<s> --nofile=256 -- node <bundle>/dist/main.js`, uid/gid dropped to a dedicated `plugin` user distinct from the supervisor user, clean env, cwd = bundle dir; bridge NDJSON JSON-RPC between child stdio and the orchestrator connection, tagging every child-originated call with `invocationId`; hard wall-clock timeout then SIGKILL; nonzero exit or timeout = failed invocation with structured error.
- **Done when:** unit tests with a fake orchestrator socket cover: happy invoke, hash mismatch refused before spawn, timeout kill, rlimit enforcement (child that tries to balloon memory dies), invocation isolation (two concurrent invokes do not cross streams).

### T2.7 Host API skeleton + grant enforcement
- **Depends:** T2.1, T2.6. **Spec:** §6.6, ADR-4 (enforcement placement).
- **Build:** orchestrator-side dispatch for child-originated calls: on every call, load the plugin's grants **from the store** (never trust the job payload), match capability + scope, execute or reject with a structured capability error. v1 methods now: `state.get/put/delete` (baseline, own namespace enforced), `log.emit` (always). Scope-matching library: path globs matched after canonicalization (absolute only, reject `..`), name prefixes, zone lists, port lists; shared with T3.6.
- **Done when:** tests: own-namespace state ops succeed; cross-namespace rejected; unknown method rejected; scope matcher unit-tested against §12.1-shaped scopes.

### T2.8 Plugin SDK
- **Depends:** T2.6, T2.7. **Spec:** §6.7.
- **Build:** `@wanfw/plugin-sdk`: `runPlugin({tasks})` reading NDJSON JSON-RPC on stdio; typed host API client; manifest and task IO types (`deploy.plan`, `network.probe`, `network.plan`, `proxy.render`, `cert.ensure`, `*.migrate`, `*.validate`); `invokePluginForTest` harness faking the host API with recorded grants so plugin repos can unit-test capability failures.
- **Done when:** harness demonstrated by T2.9.

### T2.9 Echo test plugin + M1 negative tests
- **Depends:** T2.5 to T2.8. **Spec:** §15 M1 acceptance.
- **Build:** minimal echo plugin (bundled as a test fixture, plus baked into the pluginhost test image). Integration tests: trusted echo invokes end to end; **tampered bundle** (flip one byte in the `wanfw_bundles` copy) refused at load, loudly, with audit entry; out-of-grant host call rejected; sleep task killed at `wallMs`.
- **Done when:** all four pass in CI.

### T2.10 Tier 1 plugin management UI
- **Depends:** T1.4, T2.5. **Spec:** §10.1, §10.3 (upload rules), ADR-6.
- **Build:** plugins pages: installed/trusted list with manifest + granted capabilities (read-only), pending-trust list showing hash and the **exact copyable `wanfwctl plugin trust <id>@<hash>` command**. Upload: a route handler (not a server action) that streams the request body to a temp file in `wanfw_staging` with a hard size cap (default 50 MB), computes sha256 while streaming, atomic rename, no parsing beyond hashing; session + CSRF-token protected.
- **Done when:** upload of a large fixture streams without buffering (memory assertion in test), oversize rejected, pending item appears with correct hash and command.

**Gate M1 (spec §15):** manifest loading, trust store + hash pinning, grant store, admin socket + CLI (`plugin trust/list`, `grant list/show/revoke`), pluginhost spawn/RPC/limits, host API skeleton, echo plugin; tampered-bundle, out-of-grant, and timeout tests green. §12.5 assertions still green.

---

## Phase 3: M2 reconciler + deploy path, LAN-provable (spec §15 M2)

### T3.1 Desired-state loader + migration framework
- **Depends:** T1.1, T0.2. **Spec:** §5.1, §5.2, §5.6, §7 triggers.
- **Build:** chokidar watch on `wanfw_desired` with 2s debounce, 30s poll fallback, plus `POST /nudge`; envelope + core-schema validation; core migration functions `n -> n+1` (identity for now, machinery real); refuse documents newer than known with the exact status error from §5.6; in-memory migration with per-document `needsPersist: {toVersion}` status flag; plugin-config migrations invoked via the plugin's `migrate` task in the pluginhost (sandboxed like everything else). The orchestrator never writes `wanfw_desired` (invariant 10).
- **Done when:** watch, debounce, poll fallback, nudge, too-new refusal, and needsPersist flagging all tested.

### T3.2 Composed schema assembly + validate endpoint
- **Depends:** T3.1, T2.5. **Spec:** §5.5.
- **Build:** effective schema = core + each enabled plugin's `configSchema` mounted at its anchor (`spec.deploy` for the bound deploy plugin; `plugins/<id>.json` spec for plugin configs); republish to `wanfw_status/schema.json` after every plugin-set change; Ajv validation authoritative in the orchestrator; implement `POST /validate` on the status socket as a pure function over a draft document.
- **Done when:** enabling/disabling a plugin republishes; orchestrator rejects a doc tier1's Ajv would also reject (parity fixture test); `/validate` has no side effects (test asserts no state change).

### T3.3 Dependency resolution + config-time errors
- **Depends:** T3.1, T2.5. **Spec:** §6.3, §5.3, ADR-2, veto item 2.
- **Build:** generic graph resolver over `dependencies.settings`, `dependencies.roles`, reserved `dependencies.plugins`; atomic activation (a role binding whose transitive deps fail is rejected whole); cycle rejection; structured errors naming exactly what is missing, per the §6.3 example. Include the two v1 "modeled, not implemented" behaviors: `isolationTier: "quarantine"` yields a clear "ships in v1.1" configuration-time error (never a silent downgrade); `deploymentMode: "port"` validates against the enum but errors at resolve time.
- **Done when:** tests for each error shape, atomicity, cycles, and both v1.1 stubs.

### T3.4 Reconcile engine core
- **Depends:** T3.1. **Spec:** §7.
- **Build:** level-triggered loop; trigger sources: desired-state change, 60s timer, Docker events filtered to `wanfw.managed=true` objects, scheduler hooks (cert renewal lands in T4.6), CLI actions; single reconcile at a time, queued triggers coalesce; stage driver running load -> migrate -> resolve -> PLAN -> VALIDATE -> GATE -> EXECUTE -> OBSERVE with structured per-stage errors into status.
- **Done when:** trigger coalescing tested (burst of nudges = one reconcile); a failing stage surfaces `{stage, plugin, message}` in status per §13.

### T3.5 PLAN stage wiring
- **Depends:** T3.4, T2.6 to T2.8. **Spec:** §7 PLAN, ADR-1, ADR-8.
- **Build:** per framework + per service: invoke `network-provider.plan` (endpoints, networks), `deploy.plan` (ContainerSpecs, attachments), assemble the route set, invoke `proxy-engine.render` (proxy config artifact + reload directive), derive cert requirements (names needed vs certs held). For M2 only: cert derivation short-circuits to Caddy internal CA mode (see T3.12); the seam for T4.x is the `cert requirements` output, unchanged.
- **Done when:** a two-service fixture produces the expected plan object graph (snapshot test with canonical JSON).

### T3.6 VALIDATE: field-level capability validator
- **Depends:** T3.5, T2.7, T0.2. **Spec:** §12.1, §12.2, ADR-4.
- **Build:** the authoritative field-to-capability mapping table from §12.1 as data; per-field checks against the emitting plugin's granted scopes; canonicalization rules (absolute paths only, reject `..`, string-level normalization, no host FS access; device paths must match `/dev/*`); env-key heuristic (`*_TOKEN|*_KEY|*_SECRET|PASSWORD*`) emits a status **warning** suggesting the secrets mechanism, never a gate; tier classification (routine | powerful) and powerful projection hashing via the T0.2 function; core-authority path for core-emitted scaffolding (per-service networks, proxy container, cert/proxycfg mounts) that bypasses plugin grants but is journaled and audited identically.
- **Done when:** table-driven tests: every §12.1 row has at least one pass and one scope-violation case; the spec's canonical scenario passes: a plan with `/dev/sda` fails against a `docker.device` grant scoped `/dev/dri/*` even though the plugin is trusted and honest; untrusted-plugin plans fail; projection stability tests (env edit does not change hash; image or device change does).

### T3.7 GATE: approvals
- **Depends:** T3.6, T2.1 to T2.3. **Spec:** ADR-4 item 4, ADR-6, §11, §12.2.
- **Build:** approval records `{projectionHash, serviceId, humanRendering, approvedAt, keySig}`; powerful plan without matching approval parks with status `pending-approval` and a surfaced copyable command; `wanfwctl plan list [--pending]`, `plan show <id>` (human-rendered projection: "bind mount /srv/media read-only; device /dev/dri/renderD128; image jellyfin/jellyfin:10.9.11"), `plan approve (--service <id> | <projection-hash>)`, `plan revoke` (next reconcile parks the plan); `strictApprovals: powerful | all` honored (`all` routes every plan through approval); approvals persist across reconciles.
- **Done when:** integration tests: powerful plan blocks until approved then executes; revoke parks on next reconcile; env-var edit needs no re-approval; image-tag bump on a powerful plan does; `strictApprovals: all` gates a purely baseline service.

### T3.8 EXECUTE: primitives + journal
- **Depends:** T3.6, T3.7. **Spec:** §7 EXECUTE + idempotency contract, ADR-9, §8.4.
- **Build:** dockerode primitives: `ensureNetwork`, `ensureVolume`, `ensureContainer`, `connect`, proxy config write (atomic into `wanfw_proxycfg`), proxy reload via `docker exec wanfw-proxy caddy reload …` (a `docker.exec` capability held by core on behalf of the proxy-engine flow, scoped to the managed proxy). ADR-9 labels on every created object; `wanfw.confighash` = sha256 of the canonical full ContainerSpec; unchanged hash = no-op, changed = recreate (containers) or reconfigure where Docker allows; every step journaled `(planId, step, result)`; crash mid-plan converges on next reconcile from desired state (no imperative replay).
- **Done when:** idempotency test (two reconciles, second is all no-ops); kill the orchestrator mid-execution in a test and assert convergence after restart; journal rows present.

### T3.9 OBSERVE: status documents + GC
- **Depends:** T3.8. **Spec:** §7 OBSERVE, §13, ADR-9.
- **Build:** inspect labeled objects; per-service status docs `{phase: pending|reconciling|live|degraded|pending-approval|error, endpoints, cert notAfter (stub), lastError {stage, plugin, message}, needsPersist}`; framework status doc; GC of labeled objects absent from desired state, ordered containers then networks, volumes only when the service doc set `removeVolumesOnDelete: true` (default keeps data).
- **Done when:** removing a service GCs every labeled object (assert zero labeled leftovers); volumes survive by default and are removed when opted in; unlabeled bystander containers are never touched (fixture proves it).

### T3.10 deploy-docker plugin
- **Depends:** T2.8. **Spec:** §5.4, §6.1, ADR-4 item 1.
- **Build:** `configSchema` covering the §5.4 deploy surface (image, env, mounts volume/bind, devices, resources; keep the full ContainerSpec expressible per ADR-4 "nothing is inexpressible": privileged, capAdd, ports, networkMode, user, cmd, securityOpt, restart); `plan` task mapping service doc to ContainerSpec + named-volume specs + network attachment to `wanfw_svc_<id>`. Purely declarative; zero host API Docker calls (none exist anyway).
- **Done when:** SDK-harness tests: Jellyfin-shaped doc (the §1.2 scenario) produces the expected spec; a doc requesting `/var/run/docker.sock` bind emits it verbatim (classification and gating are the orchestrator's job; asserted in T3.6/T3.7 tests).

### T3.11 network-bridge plugin
- **Depends:** T2.8, interpretation 3. **Spec:** ADR-1.
- **Build:** `probe` using ProbeContext (host port availability for 443/80 from orchestrator-supplied bindings); `plan` for `EndpointRequest{purpose:"shared-proxy", ports:[443,80], stableAddress:true}` returning dedicated bridge network + host-port publish endpoint, `properties {hostIsolated:false, dedicatedL2:false, hairpinCaveat:false}`, `operatorInstructions` ("forward WAN:443 -> <host-LAN-IP>:443"). Capability: `docker.ports.publish` scoped `[80,443]`.
- **Done when:** harness tests for probe pass/decline (ports busy) and plan shape; consumers key off `endpoint`/`properties` only (enforced by types).

### T3.12 proxy-caddy plugin + managed proxy lifecycle
- **Depends:** T3.5, T3.8, T3.11. **Spec:** §6.1, §8.4, §8.5, ADR-8, ADR-9.
- **Build:** `render` task: Caddyfile (pick Caddyfile, not JSON; per §14 pick one) with a site block per hostname reverse-proxying to `backendHost:backendPort` over the service network, and a catch-all: any unknown Host gets a static 404 over TLS with no backend contact and no service-name leak. M2 mode: `tls internal` (Caddy internal CA, LAN test only), switched to static `tls cert key` paths in T4.5. Core-emitted proxy ContainerSpec: `caddy:2.x` (digest pinned in T6.3), mounts `wanfw_certs` ro + `wanfw_proxycfg` ro, attached to the exposure network from the network plan plus every `wanfw_svc_<id>` network (dual-homed by construction); created/reconciled by the orchestrator under core authority, labeled, never in the compose file.
- **Done when:** render snapshot tests (multi-service, catch-all); reload path exercised; health checks run over service networks, not the exposure path.

### T3.13 Tier 1 schema-driven form renderer
- **Depends:** T1.4, T3.2. **Spec:** §5.5, §10.1.
- **Build:** a JSON Schema (2020-12 subset) to Mantine form renderer: string/number/integer/boolean, enum (Select), const, arrays of scalars and of objects (add/remove rows), nested objects, required, defaults, title/description as labels/hints; validation via Ajv (same schema), errors mapped to fields; renders `spec.expose` (core) + `spec.deploy` (bound deploy plugin schema) from `wanfw_status/schema.json`. Client-side validation is UX only; the orchestrator remains authoritative (§5.5).
- **Done when:** unit tests render the deploy-docker schema fixture, round-trip a Jellyfin-shaped document, and surface Ajv errors on the right fields.

### T3.14 Tier 1 service CRUD, dashboard, approvals view
- **Depends:** T3.13, T3.7, T3.9. **Spec:** §10.1, §5.6 write-back, ADR-6.
- **Build:** services list/create/edit/delete via server actions: validate with Ajv against the composed schema, atomic write to `wanfw_desired/services/<id>.json`, `POST /nudge`; delete offers the `removeVolumesOnDelete` choice with a data-loss warning. Dashboard: per-service phase, endpoints, cert expiry (stub), isolation tier; framework health; the cert `< 7 days` degraded state gets an unmissable banner slot (wired live in T4.6). Approvals page: pending powerful plans with human-rendered projections and the copyable approve command; **no approve button**. `needsPersist` handling: badge on flagged docs; "persist migration" action fetches the migrated document over the status socket and writes it with tier1's own atomic write.
- **Done when:** add/edit/remove a service end to end from the UI on the LAN stack; approvals page shows a parked plan with the correct command; needsPersist flow tested with a synthetic migration.

**Gate M2 (spec §15):** add/modify/remove a service end to end on LAN (Caddy internal CA); powerful plan blocks until approved; GC leaves nothing labeled behind; adding a no-device no-bind second service requires zero CLI interaction and is live in under a minute (§1.3); §12.5 assertions green.

---

## Phase 4: M3 real certificates (spec §15 M3)

### T4.1 Secrets store + CLI
- **Depends:** T2.1, T2.7. **Spec:** §12.4, veto item 5, §11.
- **Build:** files at `wanfw_secrets/<pluginOrCore>/<name>`, dir 0700, files 0600; host API `secrets.get/put` gated by `secrets.read/write` scope (own prefix is the norm); values injected **by value at invoke time** only when the grant covers them, never mounted into pluginhost; `wanfwctl secret set/unset/list <name>` with values via prompt or stdin only (never argv); rotation = set + affected containers bounced by next reconcile. Tier 1 secrets page: names, set/unset status, last-rotated; no value entry anywhere.
- **Done when:** permission bits asserted; argv leakage impossible (CLI rejects a value argument); cross-prefix read rejected; rotation bounce tested.

### T4.2 dns-namecheap plugin
- **Depends:** T2.8, T4.1. **Spec:** §6.1, §9 Namecheap specifics, R3.
- **Build:** `dns.apply` task (set/delete records via Namecheap API using API key from own secrets prefix); detects 403s and reports "add this host's WAN IP to the Namecheap API allowlist" as a structured, operator-visible error; propagation poll interval/backoff exposed as plugin-tunable config; validate task surfaces the coarse account-wide key caveat.
- **Done when:** harness tests against a mocked Namecheap API cover apply, delete, 403 messaging.

### T4.3 DNS broker + dns.query
- **Depends:** T2.7, T4.2. **Spec:** §6.6.
- **Build:** host API `dns.setRecord/deleteRecord` gated by `dns.record.write` zone scope and **brokered**: orchestrator forwards to the bound `dns-provider` plugin's `dns.apply` task (plugins never call each other). `dns.query`: SDK-provided resolver running in the pluginhost process space (orchestrator has no network), call round-tripped to the orchestrator for logging; advisory only.
- **Done when:** broker path tested end to end with a mock provider; zone-scope violation rejected; a cert plugin cannot invoke the DNS plugin directly (no such method exists; asserted).

### T4.4 cert-letsencrypt-dns01 plugin
- **Depends:** T4.1, T4.3. **Spec:** §9, §6.2 example manifest.
- **Build:** `cert.ensure(names)` task: ACME account created on first run, account key persisted via `secrets.put("cert-letsencrypt-dns01/acme-account-key")`; order -> `dns.setRecord(_acme-challenge TXT)` via broker -> propagation poll (authoritative NS first, then public resolvers, cap 10 min) -> finalize -> `certs.store` -> **`dns.deleteRecord` cleanup always, including on every failure path** (try/finally discipline; test it).
- **Done when:** full flow passes against Pebble (T4.7); cleanup-on-failure test kills the flow post-TXT and asserts deletion was attempted.

### T4.5 certs.store host API + cert volume + rollback
- **Depends:** T2.7, T3.12. **Spec:** §6.6, §9.
- **Build:** `certs.store(name, certPem, keyPem, meta)` gated by `certs.store`; orchestrator writes `wanfw_certs/<name>/{fullchain.pem, key.pem}` 0640 root:proxygroup atomically, retains the previous 3 generations, triggers the proxy reload pipeline; `wanfwctl cert list/renew/rollback <name>`; proxy-caddy switches from `tls internal` to static cert/key paths; wildcard key exists only in `wanfw_certs` (orchestrator rw, proxy ro) and nowhere else.
- **Done when:** store -> reload -> serve verified; rollback restores generation N-1 and reloads; permissions asserted.

### T4.6 Renewal scheduler + escalation
- **Depends:** T4.4, T4.5, T3.4. **Spec:** §7 cert scheduling, §13.
- **Build:** daily jittered tick + on-demand when the route set introduces uncovered names; renewal threshold 30 days; failure backoff 1h/4h/12h/daily with status escalation; renewal failing with under 7 days remaining escalates status to framework-wide `degraded` and lights the T3.14 UI banner (the one alarm that must be impossible to miss).
- **Done when:** scheduler unit tests with a fake clock; escalation path drives the banner in an integration test.

### T4.7 Pebble e2e + staging runbook
- **Depends:** T4.4 to T4.6. **Spec:** §14 testing, §15 M3.
- **Build:** CI compose overlay adding Pebble and a mock `dns-provider` plugin bound as the dnsProvider role; e2e: wildcard issued via DNS-01, proxy serves it, renewal exercised via Pebble short-lived certs, TXT cleanup verified including failure paths. Write `docs/staging-le-runbook.md` for one manual staging-Let's-Encrypt validation before release.
- **Done when:** e2e green in CI with no real domain.

**Gate M3 (spec §15):** wildcard issued, proxy serves it, renewal path exercised, TXT cleanup verified including failure paths, and the full §1.2 acceptance scenario passes on a real domain (manual, via the staging runbook).

---

## Phase 5: M4 macvlan + wizard (spec §15 M4)

### T5.1 IPAM host API
- **Depends:** T2.1, T2.7. **Spec:** ADR-1 (IPAM host-API-side), §6.6.
- **Build:** `ipam.allocate(rangeId)` / `ipam.release(ip)` implicit for `network-provider` plugins; allocation table in `wanfw_state`; ranges configured from `framework.spec.network.macvlan.reservedCidr` excluding the gateway.
- **Done when:** allocate/release/exhaustion/double-release tests pass; allocations survive restart.

### T5.2 network-macvlan plugin
- **Depends:** T5.1, T3.11, interpretation 3. **Spec:** ADR-1, §8.4.
- **Build:** `probe`: default-route interface detection from ProbeContext, macvlan feasibility via the core-mediated `net.probeNetwork("macvlan", parent)` helper, decline with reasons on VPS-like environments; `plan`: macvlan network on the parent iface, static proxy IP via `ipam.allocate`, endpoint `{kind:"dedicated-ip", ip}`, `properties {hostIsolated:true, dedicatedL2:true, hairpinCaveat:true}`, `operatorInstructions` with the exact forward target ("forward WAN:443 -> 192.168.x.y:443"). Capability: `docker.network.provision` scoped `mode=macvlan, parent=<iface>`.
- **Done when:** harness tests for probe accept/decline and plan shape; hairpin caveat text present; docs include the `ip link add … type macvlan` shim recipe (§8.4).

### T5.3 wanfwctl init wizard
- **Depends:** T2.5, T3.x pipeline, T4.1, T5.2, interpretation 4. **Spec:** §11 init, §8.2, §8.3, ADR-5 flow, §1.2 steps 1-2.
- **Build:** interactive wizard: collect domain, DNS provider credentials (stored via the secrets path), ACME email; run `probe()` on all installed network providers and present a choice with reasons (default `network-bridge` when both pass); batch-trust the six built-ins with full capability display (one confirmation); write the framework document (atomically, into `wanfw_desired` via… note: init runs inside the orchestrator, which must not write `wanfw_desired`; therefore init writes the framework doc through a dedicated admin-socket bootstrap endpoint that stages it for tier1 pickup **or**, simpler and honest: the framework doc is orchestrator-private bootstrap state persisted to `wanfw_state` and mirrored read-only into status for tier1 display. Choose the second; record it in PROGRESS.md as a deviation note against §5.2's file layout, keeping service docs in `wanfw_desired` untouched); set the tier1 admin password (argon2id hash written to `wanfw_tier1state`, which requires that volume mounted into the orchestrator ro? No: **write via a one-time bootstrap file in `wanfw_status` that tier1 consumes and deletes at first boot**, or prompt the operator to set it on tier1 first-run. Pick the tier1 first-run password-set page, gated to only work while no hash exists); detect WAN IP via `helper.wanIp`; render + interactively approve the initial framework plan (it is powerful-tier: `docker.ports.publish` for bridge or `docker.network.provision` for macvlan), bringing the proxy up **during** the wizard; print exact router port-forward and DNS record instructions (`*.example.tld A <wan-ip>`).
- **Done when:** fresh-stack init reaches a serving proxy in one sitting; both open sub-decisions above are resolved, implemented, and logged in PROGRESS.md; UPnP is nowhere (spec §8.3 rejects it).

### T5.4 doctor
- **Depends:** T5.3. **Spec:** §11, §13.
- **Build:** `wanfwctl doctor`: Docker socket reachability, port listen checks for the chosen provider, WAN IP vs DNS record comparison, macvlan capability probe, DNS provider reachability, iptables/nftables sanity, hairpin note when macvlan is active.
- **Done when:** each check has a pass and a fail fixture; output is structured and actionable.

### T5.5 Tier 1 first-run + setup page
- **Depends:** T1.4, T5.3. **Spec:** §10.1.
- **Build:** first-run page: admin password set (only while unset, per T5.3 decision), then a read-only mirror of the wizard's operator instructions (port forward, DNS record, WAN IP).
- **Done when:** fresh boot flows: set password -> login -> see instructions.

**Gate M4 (spec §15):** §1.2 scenario passes in macvlan mode on real hardware (manual runbook); probe correctly declines on a VPS-like environment via a veth test rig in CI; wizard + doctor complete.

---

## Phase 6: M5 hardening + docs (spec §15 M5)

### T6.1 Catastrophic-grant banners
- **Depends:** T3.7. **Spec:** ADR-4 "nothing is inexpressible", ADR-7 self-exposure.
- **Build:** detection of known-catastrophic grants and projections: Docker socket path in a bind source, `privileged`, host network + NET_ADMIN, `/dev/mem`, disk block devices; CLI approval display prints the unmissable "**This grant is equivalent to root on the host**" banner before confirmation. Self-exposure of tier1 (a service doc pointing at tier1) is force-classified powerful with its dedicated "you are exposing the control plane…" banner (ADR-7); never blocked.
- **Done when:** each catastrophic pattern has a test asserting banner text appears and approval still proceeds on explicit confirm.

### T6.2 strictApprovals: all
- **Depends:** T3.7. **Spec:** R1, §11.
- **Build:** `wanfwctl config set strictApprovals <powerful|all>`; `all` routes every plan through CLI approval.
- **Done when:** a baseline-only service is gated under `all` and self-serve under `powerful` (both tested).

### T6.3 Container hygiene pass
- **Depends:** T0.3, all images. **Spec:** §12.6, interpretation 6.
- **Build:** across all three framework images and the published compose file: non-root users, `no-new-privileges`, `cap_drop: [ALL]` with explicit adds only where required, read-only rootfs + tmpfs scratch (tier1 per interpretation 6; orchestrator RO with writable volumes only; pluginhost already RO), pinned image digests (resolve every `TODO(T6.3)`), healthchecks on all services.
- **Done when:** §12.5 harness extended to assert each hygiene property from inside the containers; `docker compose config` shows digests only.

### T6.4 Tier 1 hardening checklist
- **Depends:** T1.4, T2.10, interpretation 5. **Spec:** §10.3.
- **Build:** CSP per interpretation 5 (nonce-based script-src via middleware; strictest achievable style-src with the documented Mantine concession if required), `X-Frame-Options: DENY`, remaining security headers, strict body-size limits on every route (upload cap already in T2.10), structured request logging (method, path, status, session id hash, duration) to stdout. Note in docs: no TLS on the LAN port in v1; operators may front it; revisit with self-exposure.
- **Done when:** header assertions in integration tests; CSP violations absent in a full UI walkthrough (browser console clean); any style-src concession documented in threat-model.md.

### T6.5 Documentation set
- **Depends:** everything. **Spec:** §14 /docs, §15 M5.
- **Build:** `operator-guide.md` (install via install.sh, init walkthrough, port-forward/DNS, adding services, approvals workflow, secrets, macvlan shim recipe, doctor, update story = compose pull per §16); `threat-model.md` (publish spec §3 verbatim plus implementation notes and the R1-R5 residual risks, unhidden); `plugin-authoring.md` (manifest, capabilities and scopes, task contracts, NDJSON framing, SDK harness, trust flow from the author's side).
- **Done when:** a fresh-machine install following **only** the operator guide succeeds (record the run in PROGRESS.md).

### T6.6 Full negative acceptance + release validation
- **Depends:** all. **Spec:** §1.2 negative list, §15 M5.
- **Build:** one CI suite executing the §1.2 negative acceptance list end to end: tampered plugin bundle refused at load, loudly; powerful plan without approval does not execute and surfaces as pending; tier1 demonstrably has no path to the Docker socket (compose assertion + integration test); a service document bind-mounting `/var/run/docker.sock` is executable only after a CLI approval showing the root-equivalence banner. Plus: key rotate/import exercised; `audit tail --verify` green over the full history of the test run.
- **Done when:** suite green; staging-LE runbook executed once for the release.

**Gate M5 / MVP done:** see §5 below.

---

## 5. Cross-cutting test matrix

| Requirement | Source | Covered by |
|---|---|---|
| tier1 cannot reach docker.sock / admin.sock / state / secrets / plugin socket | §12.5, G1 | T1.5, rerun every gate |
| Orchestrator has no network beyond loopback | §2.4 | T1.5 |
| Tampered bundle refused loudly | §1.2 neg, ADR-5 | T2.9, T6.6 |
| Out-of-grant host call rejected | G5, §6.5 | T2.7, T2.9 |
| Invocation timeout kill | §15 M1 | T2.6, T2.9 |
| Status socket has no mutating endpoints | §2.2 | T1.2 allowlist test (permanent) |
| Scope-bounded plans (`/dev/sda` vs `/dev/dri/*`) | ADR-4 item 2 | T3.6 |
| Powerful plan parked without approval; approval binds projection; env edit stable, image/device change re-asks | ADR-4 item 4, §1.2 neg | T3.7 |
| Socket bind mount possible only via banner-approved path | §1.2 neg, ADR-4 | T3.6 + T3.7 + T6.1 + T6.6 |
| GC completeness, volume retention default, unlabeled objects untouched | §1.3, ADR-9 | T3.9 |
| Reconcile convergence after crash; idempotent re-run | §7 | T3.8 |
| Unknown Host = 404, no service-name leak | §8.5 | T3.12 |
| TXT cleanup on all failure paths | §9 | T4.4, T4.7 |
| Wildcard key exists only in `wanfw_certs` | §9, G8 | T4.5 + T1.5 mount assertions |
| Cert < 7 days => framework degraded, unmissable UI alarm | §13 | T4.6 |
| Macvlan probe declines on VPS-like env | §15 M4 | T5.2 (veth rig) |
| Audit chain tamper-evident | §12.3 | T2.3, T6.6 |
| Second service (no devices/binds) live in under a minute, zero CLI | §1.3 | Gate M2 |
| strictApprovals: all gates everything | R1 | T6.2 |

---

## 6. MVP definition of done

The spec §1.2 scenario, verbatim, on a fresh Linux host with Docker:

1. `docker compose up -d` brings up the framework stack.
2. `wanfwctl init` completes: domain, DNS creds, ACME email, provider probe/selection, built-ins batch-trusted with capability display, port-forward and DNS instructions printed, initial framework plan approved interactively, proxy up.
3. Tier 1 UI adds Jellyfin (image, read-only media bind, `/dev/dri/renderD128`, hostname `jellyfin`).
4. `wanfwctl plan approve` for the pending powerful plan after reviewing the projection.
5. `https://jellyfin.example.tld` serves with a valid Let's Encrypt certificate, the container isolated on its own internal network, hardware transcoding working.

Plus every item in the §1.2 negative acceptance list (T6.6), the §1.3 success criteria (second service under a minute; removal GCs everything; orchestrator restart converges), and a fresh-machine install succeeding from the operator guide alone.

Out of scope for this plan, pre-scoped for v1.1 by the spec: quarantine tier execution, port-based deployment mode, adopt-existing evaluation. The v1 codebase must contain their seams as specified (schema fields validating with clear errors, `dedicated-proxy` purpose in the provider interface, per-name cert machinery shape) but no execution paths.
