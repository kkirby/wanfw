# wanfw threat model

This document is the spec's own §3 (Threat Model), reproduced verbatim below, plus implementation notes tying each guarantee to the code that actually enforces it. Nothing here is softened or hidden: the residual risks in §3.4 are real and accepted, not oversights.

---

## §3 Threat Model (verbatim from `docs/wanfw-mvp-design-spec.md`)

### 3.1 Assets

A1. Docker socket / host root equivalence.
A2. Wildcard TLS private key for `*.example.tld`.
A3. DNS provider API credentials (can pass DNS-01 for the whole zone, i.e., can mint certs and hijack subdomains).
A4. ACME account key.
A5. LAN position of the host (a foothold container can pivot).
A6. Operator's exposed services and their data (media libraries, etc.).
A7. Integrity of the framework's own config and audit history.

### 3.2 Adversaries and positions

P1. **WAN attacker** hitting the proxy and exposed services.
P2. **Compromised Tier 1** (the brief's primary design-driving adversary): full control of the tier1 container, its volume mounts (`wanfw_desired` rw, `wanfw_status` ro, `wanfw_staging` rw, `orch-status.sock`), and its LAN position.
P3. **Compromised exposed service** (e.g., Jellyfin RCE): control of one managed container.
P4. **Malicious or trojaned plugin bundle** the operator is tricked into installing.
P5. **Honest plugin fed malicious config** (the brief's confused-deputy case: P2 writes config that a legitimate signed plugin faithfully executes).
P6. **Host attacker with Docker rights.** Out of scope: this position already owns everything (it can exec into the orchestrator). No design pretends otherwise; no HSM theater.

### 3.3 Guarantees v1 makes

G1. P2 cannot reach the Docker socket directly (no mount, no network path, no exec rights).
G2. P2 cannot cause execution of any *powerful* Docker action (bind mounts, devices, host networking, privileged, added capabilities, host port publishing, exec) without an out-of-band host CLI approval bound to the content of that action (ADR-4, ADR-6). This holds even through honest signed plugins, because enforcement is field-level in the orchestrator, on the emitted plan, not in the plugin.
G3. P2 cannot install, replace, or modify plugin code that the orchestrator will execute (hash-pinned trust store in orchestrator-private state; ADR-5).
G4. P2 cannot escalate any plugin's capability grants or forge approvals (grants/approvals live only in `wanfw_state`, mutations only via admin socket).
G5. P4's blast radius is bounded by (a) the trust step showing the full manifest and capability requests before install, and (b) runtime enforcement of exactly the granted scopes: a plugin cannot call anything outside its grants, and cannot reach the socket even if it escapes its child process, because its container has no socket (ADR-3).
G6. P3 cannot reach other services' backends (per-service networks) and cannot reach tier1, orchestrator, or pluginhost (no shared networks). In v1's standard tier, P3 can reach the proxy (necessarily) and the WAN via its network's NAT.
G7. P5 (malicious config through honest plugins) reduces to G2: the malicious *effect* requires powerful fields, which require approval, or is bounded by the baseline capability floor (§3.4 R1).
G8. A2 and A3 never reside in a WAN-exposed container (ADR-8): the proxy holds only issued certs it needs (wildcard in v1 standard tier), never DNS credentials or the ACME account key.

### 3.4 Residual risks accepted in v1 (documented, not hidden)

R1. **Baseline self-service deployments by P2.** With `strictApprovals: powerful` (default), a compromised Tier 1 can deploy containers that use only baseline capabilities: arbitrary public image, own internal network, named volumes under the framework prefix, a route on a subdomain. That is deliberately far from host compromise, but it is: a phishing page on the operator's domain, a crypto miner, a WAN-egress foothold. Mitigation available day one: `strictApprovals: all` routes *every* plan through CLI approval (`wanfwctl config set strictApprovals all`, T6.2). Default stays `powerful` because the brief's usability bar (add Kavita with zero ceremony) matters; the strict mode exists for operators who disagree.
R2. **Plugin egress is declared, not enforced.** Manifests declare intended endpoints (`net.egress`) for audit/visibility; v1 cannot technically prevent a trusted plugin's child process from connecting elsewhere (Node child in the pluginhost container with general egress). Enforcement paths (per-plugin network namespaces, or WASM with host-mediated fetch) are the designated v2 hardening; the RPC and manifest interfaces are already shaped for it (ADR-3).
R3. **DNS-01 concentrates zone power.** Holding A3 means the holder can issue certs for anything in the zone. Inherent to DNS-01. Mitigations: A3 lives only in `wanfw_secrets`; docs instruct operators to use provider-scoped tokens where available. Namecheap specifically is coarse (account-wide API key + source-IP allowlist); the wizard says so out loud and recommends the IP allowlist.
R4. **Supply chain of plugin dependencies.** Built-in plugins vendor lockfiles and are bundled at build time (no install-time `npm install` in the pluginhost). Third-party bundles are the operator's judgment at trust time; the trust flow shows the manifest, not a code audit.
R5. **Kernel/container escape.** Standard Docker isolation assumptions apply; `no-new-privileges`, non-root users, minimal images, read-only rootfs where possible are required (§12.6) but a kernel escape defeats the design. Out of scope.

---

## Implementation notes: where each guarantee actually lives

This section exists so a reviewer doesn't have to take the guarantees above on faith -- each one names the code/config that enforces it, as it stands after Gate M5.

- **G1** (`docker.sock` unreachable from tier1/pluginhost): enforced structurally, not by policy -- `deploy/docker-compose.yml` mounts `/var/run/docker.sock` only into `orchestrator`; no other service block references it, ever, including test fixtures (`test/integration/run.sh`'s own §12.5 assertions check this on every CI run: `tier1 cannot stat /var/run/docker.sock`, `pluginhost cannot stat /var/run/docker.sock`).
- **G2** (no powerful action without approval): field-by-field validation in `packages/orchestrator/src/validate/validate-plan.ts` (`validateContainerSpec`), independent of which plugin emitted the plan. The GATE stage (`packages/orchestrator/src/reconciler/gate-stage.ts`) refuses to let EXECUTE touch any `powerful`-tier service without a matching approval record keyed by the exact projection hash (§12.2). T6.1 adds unmissable banners for the worst-case powerful grants (docker.sock bind, privileged, host net + NET_ADMIN, `/dev/mem`, raw disk devices) and force-classifies self-exposure (a service document named `tier1`) as powerful with its own ADR-7 banner -- neither is ever blocked outright, per ADR-4's "nothing is inexpressible."
- **G3** (no unauthorized plugin code execution): `packages/orchestrator/src/trust/index.ts` -- the trust store is hash-pinned (`sha256` of the bundle directory tree) and lives only in `wanfw_state`, mounted only into the orchestrator. Tampered bundles are refused loudly at trust time (T2.9) and at every subsequent load (T6.6's negative-acceptance suite exercises this explicitly).
- **G4** (grants/approvals only via admin.sock): every mutating route lives in `packages/orchestrator/src/admin-socket.ts`, which listens on a path with no shared volume (`/run/wanfw-admin/admin.sock`, container-local only). The status socket (`status-socket.ts`) is read-only by construction -- a permanent allowlist test (T1.2) asserts it has zero mutating routes.
- **G5** (plugin blast radius bounded by grants): `packages/orchestrator/src/host-api/dispatcher.ts` checks every host API call against the plugin's *stored* grants (`StateStore.listGrants`), never anything the invocation payload claims about itself. Plugins run in the pluginhost container, which has no Docker socket access of any kind (ADR-3) -- there is no privilege to escalate to even if a plugin's sandboxing were somehow defeated.
- **G6** (service network isolation): every deployed service gets its own `wanfw_svc_<id>` network (ADR-9); the proxy is the only container dual-homed onto both a service's network and the shared exposure network. No compose network is shared between tier1/orchestrator/pluginhost and any deployed service.
- **G7** (confused-deputy case reduces to G2): no separate enforcement path exists for this -- it is a direct consequence of G2's field-level validation running on the plan's *content*, not on which plugin or what config produced it.
- **G8** (A2/A3 never in a WAN-exposed container): the proxy container (`packages/orchestrator/src/execute/proxy-container.ts`) mounts only `wanfw_certs`/`wanfw_proxycfg`, both read-only, both containing issued certs and rendered Caddy config -- never `wanfw_secrets` (where DNS credentials and the ACME account key live) and never the cert-issuance plugin's own runtime state.

## Documented concessions (not silent deviations)

- **CSP `style-src-attr 'unsafe-inline'` (T6.4, interpretation 5).** Spec §10.3 requires a CSP without unsafe-inline. Mantine sets CSS custom properties via element `style=` attributes at runtime, not `<style>` tags -- a fully strict `style-src` breaks it. The concession is scoped as narrowly as possible: `style-src-elem` (actual `<style>`/`<link>` tags) stays nonce-strict; only `style-src-attr` (the `style="..."` attribute itself) allows inline. `script-src` has no such concession anywhere -- it is nonce-based and `strict-dynamic` with no fallback.
- **Request log lacks status/duration (T6.4).** Next.js middleware in the supported App Router model (no custom server, a deliberate T6.3 choice to keep the read-only/standalone deployment shape) runs before the route handler and has no supported way to observe the eventual response status or measure true end-to-end duration. The structured request log (`packages/tier1/middleware.ts`) records method, path, and a hashed session id at request-received time instead of request-completed time.
- **No TLS on the tier1 LAN port in v1 (ADR-7).** Tier 1 binds HTTP on the LAN/VPN-only port by design; operators who want TLS there front it themselves (a reverse proxy, WireGuard, Tailscale). Revisit if/when self-exposure (a service document pointing at tier1 itself) becomes a supported, not just expressible, configuration.
- **Orchestrator's rootfs is not read-only (T6.3).** Unlike tier1 and pluginhost, the orchestrator container is not `read_only: true`. `orchestrator-entrypoint.sh` needs to write `/etc/passwd`/`/etc/group` at every container start to join the host's `docker.sock` group (whose GID is not knowable at build time) before dropping to the unprivileged `wanfw` user via `gosu`. `cap_drop: [ALL]` with a minimal, explicit `cap_add: [SETUID, SETGID, DAC_OVERRIDE]` narrows what that brief root window can actually do.
- **macvlan's reserved-CIDR IPAM assumes a `/24` LAN (T5.5 real-hardware fix).** `containingSlash24()` derives a macvlan network's `Subnet` from its `Gateway` by assuming a `/24`. True for the overwhelming majority of home/small-business networks; a documented, not silently absorbed, limitation for anyone running a differently-sized LAN.
