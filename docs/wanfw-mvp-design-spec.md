# wanfw: Composable Self-Hosted WAN Exposure Framework
## MVP Design Specification v0.1

**Status:** Draft for implementation handoff
**Date:** 2026-07-11
**Source:** `brief.md` (scoping handoff brief). All "locked" decisions in the brief are treated as constraints. All open questions in brief §5 are resolved here as Decision Records (§4) with rationale and rejected alternatives.
**Audience:** An implementing agent (e.g., Claude Code) building the MVP end to end. This document is intended to be sufficient to build from without re-deriving the security model.
**Working name:** `wanfw` (binary/CLI: `wanfwctl`). Placeholder, rename freely; no code should hardcode the name outside one constants module.

### Interpretations made beyond the brief (veto list)

The brief left a few things ambiguous. The following interpretations were made and should be vetoed before implementation if wrong:

1. **Managed services only in v1.** The framework creates and owns the service containers it exposes (from declarative service documents). "Adopt an existing container the operator already runs" is explicitly deferred (see §16). The brief's pipeline language ("container creation, network attachment") supports either reading; owning the containers keeps reconciliation and GC sane.
2. **Port-based deployment mode is modeled but not implemented in v1.** The `deploymentMode` enum, plugin dependency constraints, and validation machinery all exist in v1 (so the constraint system is real, not vestigial), but only `subdomain` mode executes. Port mode ships v1.1 alongside the quarantine tier.
3. **Tier 1 gets minimal local admin auth in v1** (single admin account, argon2id, session cookie). The brief's "auth/SSO out of scope" refers to auth for *exposed services*. An unauthenticated control plane on the LAN is not acceptable even LAN-only.
4. **Caddy does not run its own ACME.** Cert issuance is centralized in the orchestrator via the cert plugin (ADR-8). This is a deliberate deviation from the "just let Caddy do it" default; rationale in ADR-8.
5. **Secrets are entered via the host CLI only in v1.** Tier 1 UI shows secret names and set/unset status but never accepts secret values. Rationale in §12.4.
6. **Per-service internal networks in v1** (one Docker network per exposed service, proxy attached to all). Not in the brief, but cheap and it removes backend-to-backend lateral movement in the standard tier. See ADR-2.

---

## 1. Overview and Goals

### 1.1 What this is

A self-hostable framework, deployed as a single Docker Compose stack on one host, that lets a homelab operator expose arbitrary Docker services (Plex, Jellyfin, Kavita, etc.) to the WAN over HTTPS with secure defaults and no per-service manual network engineering.

### 1.2 MVP definition (acceptance scenario)

On a fresh Linux host with Docker installed, an operator can:

1. `docker compose up -d` the framework stack.
2. Run `wanfwctl init` (interactive wizard): supply domain, DNS provider credentials, ACME email; wizard probes the environment, selects/confirms a network provider, batch-trusts the six built-in plugins (with capability display), and prints exact router port-forward and DNS record instructions.
3. In the Tier 1 UI, add a service: Jellyfin, image `jellyfin/jellyfin:<tag>`, media bind mount (read-only), `/dev/dri/renderD128` device for hardware transcoding, hostname `jellyfin`.
4. Run `wanfwctl plan approve` for the pending powerful plan (device + bind mount), after reviewing what it grants.
5. Reach `https://jellyfin.example.tld` with a valid Let's Encrypt certificate, with the Jellyfin container isolated on its own internal network, and hardware transcoding working.

Negative acceptance (must also pass):

- A tampered plugin bundle (hash mismatch vs trust store) is refused at load, loudly.
- A powerful plan without an approval record does not execute; status surfaces it as pending.
- Tier 1's container demonstrably has no path to the Docker socket (compose-level assertion + integration test).
- A service document requesting a bind mount of `/var/run/docker.sock` is executable *only* after a CLI approval that displays an explicit "equivalent to root on the host" banner (see ADR-4; nothing is silently impossible, everything catastrophic is loud).

### 1.3 Success criteria beyond the demo

- Adding a second service (e.g., Kavita, no devices, no binds) requires zero CLI interaction: UI add, auto-reconcile, live in under a minute.
- Removing a service GCs every Docker object the framework created for it (containers, networks, routes, certs where per-name).
- Killing and restarting the orchestrator converges to the same state (level-triggered reconciliation, no replay of imperative history).

---

## 2. System Topology

### 2.1 Components

| Component | Container | Docker socket | Network exposure | Role |
|---|---|---|---|---|
| Tier 1 UI/BFFE | `wanfw-tier1` | **Never** | LAN (published port, e.g. 8443) | Web UI, config authoring, validation UX, status display |
| Orchestrator (Tier 2a) | `wanfw-orchestrator` | **Yes (only holder)** | None published; Unix sockets only | Reconciler, capability enforcement, trust store, approvals, mediated Docker API, cert scheduling, admin socket for CLI |
| Plugin host (Tier 2b) | `wanfw-pluginhost` | Never | None published; Unix socket to orchestrator only | Executes signed plugin bundles, one child process per invocation, no secrets at rest |
| Reverse proxy (data plane) | `wanfw-proxy` (Caddy, managed) | Never | WAN path (via network provider) + per-service internal networks | TLS termination, Host-based routing |
| Managed services | `wanfw-svc-<id>` (managed) | Never | Own internal network only (standard tier) | The operator's workloads (Jellyfin etc.) |

The brief's "Tier 2" is split into two containers (orchestrator + plugin host). This split is the resolution of the plugin isolation question and is justified in ADR-3. It does not change the brief's trust topology: the socket still has exactly one holder, and Tier 1 still has no path to it.

The framework stack (tier1, orchestrator, pluginhost) is defined in Compose. The proxy and service containers are **not** in the Compose file; they are created by the orchestrator via the Docker API, labeled for ownership, and reconciled continuously. Compose owns the control plane; the orchestrator owns the data plane.

### 2.2 Volumes and channels

| Volume | Mounted by | Mode | Purpose |
|---|---|---|---|
| `wanfw_desired` | tier1 (rw), orchestrator (ro) | shared | Desired-state documents (the "config store" from the brief §2) |
| `wanfw_status` | orchestrator (rw), tier1 (ro) | shared | Status documents, composed JSON Schema, pending-approval summaries |
| `wanfw_staging` | tier1 (rw), orchestrator (ro) | shared | Uploaded plugin bundles awaiting trust |
| `wanfw_state` | orchestrator only | private | SQLite: trust store, grants, approvals, IPAM, plugin KV, execution journal, audit log, signing key |
| `wanfw_secrets` | orchestrator only | private | Secret files, root-only (0700 dir, 0600 files), per brief §4 |
| `wanfw_certs` | orchestrator (rw), proxy (ro) | shared | Issued certificates + keys for the proxy |
| `wanfw_proxycfg` | orchestrator (rw), proxy (ro) | shared | Generated Caddy config |
| `wanfw_rpc_status` | orchestrator (rw), tier1 (rw) | shared | Unix socket `orch-status.sock` (tier1's read/notify API) |
| `wanfw_rpc_plugin` | orchestrator (rw), pluginhost (rw) | shared | Unix socket `orch-plugin.sock` (invocation protocol). **Deliberately a separate volume from the status socket:** if both sockets shared one volume, a compromised Tier 1 could speak the invocation protocol to the pluginhost directly, bypassing the orchestrator. Tier 1 never mounts this volume. |
| `wanfw_bundles` | orchestrator (rw), pluginhost (ro) | shared | Trusted plugin bundles, copied in at trust time, keyed by hash (ADR-5) |
| `wanfw_tier1state` | tier1 only | private | Admin password hash (argon2id), session store |

Rules:

- **Desired state flows one way:** tier1 writes `wanfw_desired`, orchestrator reads. Writes are atomic (temp file + `rename(2)`). Orchestrator watches via inotify with a 2s debounce and a 30s poll fallback.
- **The tier1 → orchestrator network API is read/notify only.** Over `orch-status.sock`, tier1 may: read status, read the composed config schema, read pending approvals, ask for validation of a draft document (pure function), and send a "config changed" nudge. There are **no state-mutating endpoints** on this socket. Every security-relevant mutation (trust, grant, approve, secrets) happens on the admin socket, which tier1 cannot reach (§2.3).
- `wanfw_state` and `wanfw_secrets` are never mounted anywhere except the orchestrator. This is the load-bearing isolation for the trust model (ADR-5, ADR-6).

### 2.3 Admin channel

The orchestrator exposes a second Unix socket, `admin.sock`, inside its own container only (not on any shared volume). The host CLI reaches it via `docker exec`:

```
wanfwctl <cmd>   ==   docker exec -i wanfw-orchestrator wanfwctl-inner <cmd>
```

A thin host wrapper script (installed by `wanfwctl init`, or invoked directly) does the exec. This gives an approval channel that a compromised Tier 1 cannot reach, touch, or observe, using no extra host mounts: reaching it requires Docker socket rights on the host, which is the correct bar (whoever can exec into the orchestrator already owns the host in this threat model).

### 2.4 Network layout

| Network | Type | Members | Purpose |
|---|---|---|---|
| `wanfw_admin` | bridge | tier1 | Publishes UI port to LAN interface |
| `wanfw_exposure` | provided by network-provider plugin (bridge-publish or macvlan) | proxy | WAN-facing path for 443/80 |
| `wanfw_svc_<id>` | bridge, `internal: true` | proxy + that one service | One per service; proxy is dual-homed onto each |
| `wanfw_egress` | bridge, outbound only (no published ports) | pluginhost | ACME + DNS provider API calls originate in plugin code, so the pluginhost is the one component besides the proxy/tier1 with a network at all |
| (none) | | orchestrator | `network_mode: none`; all its communication is Unix sockets |

Egress accounting: image pulls happen via the Docker daemon (host network), not from the orchestrator, so the orchestrator genuinely needs no network. The pluginhost's general egress is a v1 concession; per-plugin egress enforcement is deferred (§3.4, residual risk R2).

---

## 3. Threat Model

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

R1. **Baseline self-service deployments by P2.** With `strictApprovals: powerful` (default), a compromised Tier 1 can deploy containers that use only baseline capabilities: arbitrary public image, own internal network, named volumes under the framework prefix, a route on a subdomain. That is deliberately far from host compromise, but it is: a phishing page on the operator's domain, a crypto miner, a LAN-adjacent... no, not LAN-adjacent (internal network + NAT egress only), but a WAN-egress foothold. Mitigation available day one: `strictApprovals: all` routes *every* plan through CLI approval. Default stays `powerful` because the brief's usability bar (add Kavita with zero ceremony) matters; the strict mode exists for operators who disagree.
R2. **Plugin egress is declared, not enforced.** Manifests declare intended endpoints (`net.egress`) for audit/visibility; v1 cannot technically prevent a trusted plugin's child process from connecting elsewhere (Node child in the pluginhost container with general egress). Enforcement paths (per-plugin network namespaces, or WASM with host-mediated fetch) are the designated v2 hardening; the RPC and manifest interfaces are already shaped for it (ADR-3).
R3. **DNS-01 concentrates zone power.** Holding A3 means the holder can issue certs for anything in the zone. Inherent to DNS-01. Mitigations: A3 lives only in `wanfw_secrets`; docs instruct operators to use provider-scoped tokens where available. Namecheap specifically is coarse (account-wide API key + source-IP allowlist); the wizard says so out loud and recommends the IP allowlist.
R4. **Supply chain of plugin dependencies.** Built-in plugins vendor lockfiles and are bundled at build time (no install-time `npm install` in the pluginhost). Third-party bundles are the operator's judgment at trust time; the trust flow shows the manifest, not a code audit.
R5. **Kernel/container escape.** Standard Docker isolation assumptions apply; `no-new-privileges`, non-root users, minimal images, read-only rootfs where possible are required (§12.6) but a kernel escape defeats the design. Out of scope.

---

## 4. Decision Records

Each record: context, decision, rationale, rejected alternatives, consequences. These resolve brief §5.1 through §5.4 plus decisions the brief delegated.

---

### ADR-1: Network isolation strategy is a plugin type (`network-provider`); v1 ships `bridge` and `macvlan` providers
*(resolves brief §5.1)*

**Context.** Macvlan was the original selling-point architecture (dedicated L2 identity for the proxy, network-layer isolation from the host stack). But macvlan is unavailable or broken in common environments: most VPS/cloud virtual NICs (MAC filtering / no promiscuous mode), WiFi uplinks, some virtualized bridges. The brief warns against designing a "generic" interface that is secretly macvlan-shaped.

**Decision.** Introduce plugin type `network-provider`. Its contract is expressed in *outcomes*, not mechanisms:

```ts
interface NetworkProvider {
  // Called by the wizard and on demand. Reports whether this provider can
  // function here, and why not if not (used for provider selection UX).
  probe(env: ProbeContext): ProbeResult;

  // Declarative: given requirements, return the resources the orchestrator
  // should ensure, plus the properties the rest of the system may rely on.
  plan(req: EndpointRequest): NetworkPlan;
}

interface EndpointRequest {
  purpose: "shared-proxy" | "dedicated-proxy";   // dedicated-proxy used by quarantine tier (v1.1)
  ports: number[];                               // e.g. [443, 80]
  stableAddress: boolean;                        // subdomain mode requires true
}

interface NetworkPlan {
  resources: DockerNetworkSpec[];                // networks to ensure
  attachment: ContainerAttachmentSpec;           // how to attach the proxy
  endpoint: { kind: "dedicated-ip"; ip: string } // macvlan
          | { kind: "host-ports"; ports: PortMap[] }; // bridge publish
  properties: {
    hostIsolated: boolean;      // container invisible to host stack (macvlan caveat included in docs)
    dedicatedL2: boolean;
    hairpinCaveat: boolean;     // macvlan: host cannot reach the IP without a shim; affects operator debugging only (health checks run over wanfw_svc_* nets, §8.4)
  };
  operatorInstructions: string; // rendered by wizard/UI: exact port-forward target etc.
}
```

Consumers (wizard output, DNS instructions, proxy deployment, future quarantine tier) key off `endpoint` and `properties`, never off the provider's identity. IPAM for `dedicated-ip` providers is host-API-side: the orchestrator owns the allocation table (in `wanfw_state`), the provider requests an address from the configured reserved range via `host.ipam.allocate()`. This keeps address bookkeeping out of plugin state and makes multiple providers coexist safely.

v1 ships both providers built-in:

- `network-bridge` (default): dedicated bridge network for the proxy, publishes 443 (+80 optional redirect) on the host. Probe checks host port availability. Capability: `docker.ports.publish` scoped to `[80, 443]`, granted during wizard.
- `network-macvlan` (opt-in): wizard probe auto-detects the default-route interface, asks for a reserved CIDR slice outside the DHCP pool and the gateway, creates the macvlan network, allocates the proxy a static IP. Capability: `docker.network.provision` scoped to `mode=macvlan, parent=<iface>`.

**Rationale.** The framework's actual dependency is "the proxy is reachable on 443 from the router with a stable target." Both providers satisfy it. Making the *properties* declared rather than assumed is what prevents the macvlan-shaped-interface failure: nothing downstream may assume `dedicatedL2`.

**Rejected alternatives.**
- *Macvlan baked into core, bridge as fallback flag:* fails the brief's own test; every non-macvlan environment becomes a special case in core code.
- *Core does bridge, macvlan as the only plugin:* asymmetric; the provider interface would never be exercised by two real implementations in v1 and would calcify wrong.

**Consequences.** The wizard must run `probe()` on all installed providers and present a choice with reasons. Quarantine tier (ADR-2) reuses `purpose: "dedicated-proxy"` unchanged, which is the test that the interface isn't v1-shaped either.

---

### ADR-2: Quarantine tier is first-class in the data model and pipeline from day one; execution ships in v1.1
*(resolves brief §5.2)*

**Context.** The brief leans toward automated per-service full isolation (dedicated proxy + dedicated network identity) as a real feature. MVP scope simultaneously locks "single proxy instance."

**Decision.**
1. `spec.expose.isolationTier: "standard" | "quarantine"` exists in the service schema from v1. v1 validates it; selecting `quarantine` in v1 yields a clear "ships in v1.1" configuration-time error, not a silent downgrade.
2. The pipeline is written so a tier is just a different plan shape: `standard` produces (service container + `wanfw_svc_<id>` network + route entry in the shared proxy's config); `quarantine` produces (service container + dedicated network + dedicated proxy container via `EndpointRequest{purpose:"dedicated-proxy"}` + its own cert). No new pipeline stages, only different plan contents.
3. **Cert policy for quarantine (specified now, binding for v1.1):** quarantine proxies receive a per-hostname certificate (`jellyfin.example.tld`), never the wildcard. Rationale: the quarantine threat model assumes the adjacent service is hostile; if it ever compromises its dedicated proxy, the blast radius is one hostname's key, not `*.example.tld` (asset A2). The shared proxy remains the only holder of the wildcard key.
4. **v1 already ships the cheap 80% of quarantine's value:** per-service internal networks (veto item 6) mean standard-tier backends cannot reach each other today. What quarantine adds on top is proxy-process isolation and (with macvlan) a dedicated L2 identity, which is exactly the part that needs IPAM for multiple addresses, per-name issuance, and N-proxy config management: bounded, specified, deferred.

**Rationale.** Deferring execution keeps MVP shippable and honors the locked "single proxy" MVP scope; putting the tier in the schema and plan model now is what makes v1.1 an additive release instead of a migration. The per-name cert rule is the one decision that would be expensive to retrofit if gotten wrong (key distribution habits calcify), so it is locked now.

**Rejected alternatives.**
- *Quarantine fully in v1:* pulls IPAM-for-many, per-name ACME issuance rate handling, and multi-proxy config reload into the critical path of the first release for a feature the motivating use case doesn't need.
- *Quarantine as documentation-only escape hatch:* rejected per the brief's lean; also per-service networks in v1 prove the pipeline can express isolation variance, so "automation later" is credible, not vaporware.

---

### ADR-3: Plugin execution isolation: dedicated pluginhost container + one child process per invocation
*(resolves brief §5.3, isolation mechanism)*

**Context.** The brief lists four candidate mechanisms and correctly flags in-process `vm`/`vm2` as inadequate near a Docker socket. There is a trap in the "child process per plugin" option as usually imagined: **a child process spawned inside the socket-holding container shares its filesystem namespace and can simply `open("/var/run/docker.sock")`.** Process isolation without mount isolation is decoration here.

**Decision.** Split the brief's Tier 2 into two containers:

- `wanfw-orchestrator`: holds the socket, the state DB, the secrets, the signing key, the capability engine, the reconciler, the admin socket. Runs **no plugin code, ever**.
- `wanfw-pluginhost`: holds **no** socket, no state volume, no secrets volume. Receives invocation jobs from the orchestrator over `orch-plugin.sock` (JSON-RPC 2.0). For each invocation it verifies the bundle hash against the job's pinned hash, spawns one child process (`node <bundle>/dist/main.js`) as an unprivileged user with `no-new-privileges`, rlimits (CPU time, memory, open files), and a hard wall-clock timeout, and bridges JSON-RPC between the child's stdio and the orchestrator socket. Plugins are **ephemeral invocations, not daemons**: the orchestrator owns all scheduling (renewal timers, reconcile triggers); a plugin is a function from (task, input, host API handle) to a result.

Enforcement placement is absolute: **the pluginhost is a dumb supervisor and pipe.** Every host API call a plugin makes travels child → pluginhost → orchestrator, and the orchestrator checks it against the plugin's grants before doing anything. A fully compromised pluginhost gains: the ability to lie in plugin results and to make host API calls *within the union of currently-invoked plugins' grants*. It does not gain the socket, secrets at rest, or the trust store.

**Isolation retrofit path (satisfies the brief's non-goal constraint):** the plugin-facing contract is (manifest schema, task inputs/outputs, JSON-RPC host API). None of those name Node. Swapping the child-process substrate for WASM/WASI with the same host API, or adding per-plugin network namespaces inside the pluginhost, changes zero plugin-visible surface. This is the designed v2 hardening for residual risk R2.

**Rejected alternatives.**
- *`vm`/`vm2`-style in-process:* per brief; CVE history; and in-process means in-container means socket-adjacent.
- *Worker threads in the orchestrator:* same container, same filesystem, same socket file. The message-passing API would be theater.
- *Child processes inside the orchestrator with uid separation (socket 660 root:docker, plugin child as nobody):* workable but requires the orchestrator to run as in-container root with CAP_SETUID to demote children, and one misconfigured mount defeats it silently. The two-container split achieves the same with Compose-visible, auditable boundaries.
- *WASM in v1:* strongest, but forces every plugin author (including us, six times) through a WASI toolchain now, for a v1 whose brief explicitly allows lighter-weight isolation if the interface survives hardening. Kept as the substrate upgrade.

**Consequences.** Two Tier 2 containers instead of one (Compose entries, shared RPC volume). Cert plugins doing ACME need egress, so pluginhost keeps outbound network (R2). Plugin bundles must be visible to the pluginhost: built-ins ship in its image; third-party bundles are placed by the orchestrator into a `wanfw_bundles` volume (orchestrator rw, pluginhost ro) at trust time, keyed by hash.

---

### ADR-4: Capability model: scoped grants + field-level plan validation + two-tier approval
*(resolves brief §5.3, capability/confused-deputy core)*

**Context.** Signing/pinning stops code substitution (P4-via-P2). It does nothing about P5: a compromised Tier 1 writing config that an honest plugin faithfully turns into `--privileged` or a socket bind mount. The brief's constraint: nothing may be technically inexpressible; the boundary must be *what is granted*, explicit, visible, revocable, loud when powerful.

**Decision.** Four interlocking mechanisms:

**(1) Docker-touching plugins are declarative.** A deploy/network/proxy plugin's `plan` task returns a *resource plan* (ContainerSpecs, network specs, route sets, rendered proxy config). Plugins never make imperative Docker calls. The orchestrator validates the returned plan **field by field** against a fixed mapping (§12.1) from spec fields to required capabilities, then executes the primitives itself. Consequence: the capability check sits on the *effect*, in the orchestrator, regardless of which plugin (or how honest it was, or what config it was fed) produced it. Imperative host API calls exist only for non-Docker side effects (DNS records, ACME) where interactivity is inherent; those are individually capability-checked per call.

**(2) Grants are scoped, not boolean.** A grant is `(pluginId, capability, scope)`:

```json
{ "plugin": "deploy-docker", "cap": "docker.device",
  "scope": { "paths": ["/dev/dri/*"] } }
```

Grant scopes bound the universe a plugin can ever emit. `docker.device` granted for `/dev/dri/*` makes a plan containing `/dev/sda` fail validation even though the plugin is signed, trusted, and honest. This is the direct answer to the brief's "config entry requesting a Docker socket bind-mount via a real plugin just doing its job" scenario: the deploy plugin's bind-mount grant is scoped to the operator's chosen paths, and `/var/run/docker.sock` is not in them unless the operator put it there through the loud path.

**(3) Capabilities are tiered.**

- **Baseline** (self-service via Tier 1, auto-executed under default `strictApprovals: powerful`): attach to the service's own managed network; named volumes under the `wanfw_` prefix; image pull; env vars; resource limits; route write for the service's own hostnames; plugin-namespaced KV state; `dns.query`; reading secrets under the plugin's own prefix.
- **Powerful** (requires both a covering grant *and* a per-content approval, ADR-6): bind mounts (`docker.mount.bind`, path-glob scope), devices (`docker.device`), host networking (`docker.network.host`), privileged (`docker.privileged`), added Linux capabilities (`docker.capabilities`), host port publishing (`docker.ports.publish`), exec into managed containers (`docker.exec`, used by the proxy-engine reload path), network provisioning (`docker.network.provision`), DNS record writes (`dns.record.write`, zone scope), secrets outside own prefix.

**(4) Powerful execution binds to an approved content hash.** For any plan classified powerful, the orchestrator computes the **powerful projection**: `sha256(canonicalJSON({serviceId, sortedPowerfulFields}))` where `sortedPowerfulFields` contains exactly the powerful-tier field values (mount sources/targets/modes, device paths, image reference, privileged flag, cap lists, published ports, host-network flag). The plan executes only if that hash has an approval record in `wanfw_state`. Approvals persist across reconciles; editing an env var does not change the projection and needs no re-approval; changing the image tag or a device path does, deliberately (a device-granted container's image is supply chain). The image reference is included in the projection *only* for powerful plans; baseline services update images freely.

**Nothing is inexpressible.** `ContainerSpec` covers the full create surface the framework will ever need (image, cmd, entrypoint, env, mounts of all types, devices, network attachments, port publishing, cap_add/drop, privileged, security_opt, user, resources, restart policy, labels). Granting `docker.mount.bind` scoped to `/var/run/docker.sock`, or `docker.privileged`, is possible. The CLI approval display for known-catastrophic grants and projections (socket path, privileged, host network + NET_ADMIN, /dev/mem, disk block devices) prints an unmissable banner: **"This grant is equivalent to root on the host."** Loud, not blocked, per the brief.

**Rejected alternatives.**
- *Per-call imperative Docker API with capability checks:* checkable, but no stable content to bind approvals to, so the approval gate degenerates to "approve every reconcile" or "approve the plugin forever." Declarative plans are what make G2's per-content consent implementable.
- *Approval on whole-plan hash:* every env tweak on a device-using service would ping-pong to the CLI. The powerful projection is the right consent granularity: re-ask exactly when the dangerous surface changes.
- *Hard denylist of catastrophic specs:* violates the brief's explicit constraint. The banner is the compromise the brief itself sketches (mobile-OS-style permission moments).
- *Service-level rather than plugin-level grants only:* plugin grants without per-content approval leave P5 open (honest plugin, granted device scope, malicious new service config reusing it). Both layers are needed; they answer different questions ("what may this code ever do" vs "did the operator consent to this concrete effect").

---

### ADR-5: Plugin trust: hash pinning in orchestrator-private store; Ed25519 key signs records; custody at first boot
*(resolves brief §5.3, signing + key custody)*

**Context.** The brief locks "Tier 2 holds a signing key Tier 1 cannot access" and asks for the custody mechanism, allowing operator-self-signed for MVP.

**Decision.**
- **The load-bearing mechanism is hash pinning in a Tier-1-unwritable store.** Trusting a plugin = recording `(pluginId, version, sha256(bundle), grantedCapabilities)` in `wanfw_state` via the admin socket. Every invocation verifies the bundle against the pinned hash. This alone yields G3: for a *local* trust decision, a pinned hash in a store the attacker cannot write is exactly as strong as a signature, and simpler. The spec says this out loud rather than cargo-culting signatures.
- **The Ed25519 key still exists and earns its keep:** generated at orchestrator first boot into `wanfw_state` (0600), it signs trust records, grant records, approval records, and audit-log checkpoints. That makes the security-decision history tamper-evident and *portable* (exportable, verifiable off-box), and it means the verifier code path for a future registry with author signatures already exists; remote-signed plugins become a drop-in trust source instead of a rearchitecture.
- **Custody:** generated at first boot; `wanfwctl key show` (public), `wanfwctl key rotate` re-signs all live records. Operator-supplied key accepted via `wanfwctl key import` for people who want custody elsewhere. No passphrase wrapping in v1: the key's confidentiality boundary is the orchestrator volume, and P6 (host root) defeats any local wrapping anyway. Honest, minimal.
- **Flow:** built-ins ship in the pluginhost image but get **no implicit trust**; the wizard runs the same trust flow (`wanfwctl plugin trust --builtin-all` displays each manifest + requested capabilities, one confirmation). Third-party: Tier 1 stages the bundle into `wanfw_staging`; orchestrator hashes it and lists it pending; `wanfwctl plugin trust <id>@<hash>` shows manifest and capability requests, confirms, records, copies the bundle into `wanfw_bundles` keyed by hash. Tier 1 staging a *different* bundle later changes nothing: the pinned hash no longer matches anything staged, and the trusted copy in `wanfw_bundles` is Tier-1-unreachable.

**Rejected alternatives.**
- *Author-signature PKI in v1:* there is no registry, no authors, no revocation infrastructure yet; it would be ceremony around a trust decision the operator is making by hash anyway.
- *Signature as the load-bearing local mechanism:* adds a key-management failure mode without adding security over the pinned hash for the P2 adversary.

---

### ADR-6: Approval channel is the host CLI over the orchestrator admin socket; Tier 1 can display but never approve
*(resolves brief §5.3, "explicit, visible, revocable, loud" mechanics)*

**Context.** The operator's only UI is Tier 1, and Tier 1 is the designated likely-compromised component. An approval button in Tier 1 is an approval button for the attacker.

**Decision.** All of the following happen **only** via `wanfwctl` (§2.3): plugin trust/untrust, capability grant/revoke, powerful-plan approval/revocation, secrets set/unset, key operations, `strictApprovals` changes. Tier 1 shows pending items with copy-pasteable commands (`wanfwctl plan approve --service jellyfin`) but owns no mutation path. Approvals display the full powerful projection (human-rendered: "bind mount /srv/media read-only; device /dev/dri/renderD128; image jellyfin/jellyfin:10.9.11") before confirming.

**Rejected alternatives.**
- *Confirmation codes displayed by orchestrator logs, typed into Tier 1:* confused-deputy: once typed, compromised Tier 1 holds a live code and can attach it to a different pending request unless codes bind to content hashes and the operator verifies the hash out-of-band anyway, at which point it has become a worse CLI.
- *A second, "secure" web UI served by the orchestrator:* moves HTTP parsing and auth into the socket-holding component, recreating the exact attack surface the Tier 1/2 split exists to keep away from the socket.
- *Approvals in Tier 1 with TOTP:* authenticates the operator to Tier 1, but Tier 1 is the adversary; it can present request A and submit request B.

**Consequences.** The operator needs host shell access for security-relevant changes. For the target user (self-hoster who ran `docker compose up`) this is a given, and it is arguably the most honest implementation of the brief's "deliberate, visible act."

---

### ADR-7: Tier 1 is LAN/VPN-only by design in v1
*(resolves brief §5.4)*

**Decision.** Tier 1 binds to a LAN interface/port and is never routed through the managed proxy by default. Remote admin story: WireGuard/Tailscale to the LAN (documented, not implemented). Self-exposure (adding Tier 1 itself as an exposed service) is not blocked, consistent with the escape-hatch philosophy, but the plan is force-classified powerful with a dedicated banner ("you are exposing the control plane of this system to the WAN behind password auth only"), so it requires CLI approval.

**Rationale.** The entire architecture prices Tier 1 as the component most likely to fall (brief §2). WAN exposure multiplies attempts against it while its auth story is a single local password (SSO/auth plugins are explicitly post-MVP). Hardening Tier 1 to exposed-app standard is real work with no MVP payoff; the LAN/VPN stance also collapses §5.4's open question about matching hardening levels: v1 hardens Tier 1 to LAN-threat standard (§10.3) and says so.

**Consequences.** Once auth plugins exist (post-MVP), WAN admin can become a supported, loudly-warned configuration; nothing in the topology prevents it (it is just a service document pointing at Tier 1).

---

### ADR-8: Certificate issuance is centralized in the orchestrator/cert-plugin; the proxy never runs ACME
*(delegated by brief §3/§4; deviates from the common Caddy default)*

**Context.** Caddy's marquee feature is built-in ACME, including DNS-01 via provider modules. Using it would delete code.

**Decision.** Caddy runs with statically provided certificates (`tls cert key` per site / wildcard), read-only from `wanfw_certs`. Issuance and renewal are driven by the orchestrator's scheduler invoking the cert-issuer plugin, which performs ACME and DNS-01 via the host API brokered to the DNS provider plugin (§6.6).

**Rationale, in order of weight:**
1. **Asset placement (G8).** Caddy-native DNS-01 puts the DNS provider credential (A3, zone-hijack-grade) inside the single most WAN-exposed container. The framework's proxy is the component P1 hits all day.
2. **Pluggability lives in our system, not Caddy's module matrix.** Provider support becomes "write a `dns-provider` plugin against the Lego-shaped interface," identical whether the engine is Caddy, Nginx (whose future HTTP-01 plugin is an explicit brief use case), or anything else. Cert logic written against Caddy's ACME would need re-solving for the first non-Caddy engine.
3. Quarantine-tier per-name issuance (ADR-2) and future HTTP-01 flow through the same scheduler and plugin seam.

**Tradeoff accepted.** The framework owns renewal correctness: scheduling, retry/backoff, propagation checks, expiry alerting (§9). That is the price of 1 and 2, and it is bounded, well-trodden code.

**Rejected alternative.** *Caddy does ACME, framework does everything else:* fastest MVP, wrong asset placement, and it welds cert acquisition to one engine in a system whose brief explicitly demands the engine be a swappable plugin type.

---

### ADR-9: Framework-managed workloads only; ownership via labels
*(interpretation, veto item 1)*

**Decision.** Every Docker object the framework creates carries labels:

```
wanfw.managed=true
wanfw.service=<id>          (where applicable)
wanfw.plan=<planId>
wanfw.confighash=<sha256>
```

Reconciliation diffs desired state against `wanfw.managed=true` objects only. Objects without the label are invisible to the framework: never inspected for routing, never GC'd, never attached. "Adopt existing container" is deferred (§16) because attaching networks to containers owned by someone else's compose file breaks on their next `up` and creates split-brain ownership that reconciliation cannot resolve honestly.

---

## 5. Configuration Model

### 5.1 Stores recap

Desired state (`wanfw_desired`, Tier 1 authors) / orchestrator private state (`wanfw_state`, SQLite) / status (`wanfw_status`, orchestrator authors) / secrets (`wanfw_secrets`). See §2.2 for mount rules.

### 5.2 Document envelope

Every desired-state document:

```json
{
  "schemaVersion": 1,
  "kind": "Framework" | "Service" | "PluginConfig",
  "metadata": { "id": "<stable-id>", "displayName": "..." },
  "spec": { }
}
```

One JSON file per document: `framework.json`, `services/<id>.json`, `plugins/<id>.json`. Atomic writes (temp + rename). Files are operator-inspectable and diff-friendly on purpose (GitOps-adjacent; a future "sync from git" sits naturally on this store).

### 5.3 Framework document

```json
{
  "schemaVersion": 1,
  "kind": "Framework",
  "metadata": { "id": "framework" },
  "spec": {
    "domain": "example.tld",
    "deploymentMode": "subdomain",
    "acmeEmail": "ops@example.tld",
    "roles": {
      "networkProvider": "network-bridge",
      "proxyEngine": "proxy-caddy",
      "certIssuer": "cert-letsencrypt-dns01",
      "dnsProvider": "dns-namecheap"
    },
    "strictApprovals": "powerful",
    "network": {
      "lanInterface": "eth0",
      "macvlan": { "parent": "eth0", "reservedCidr": "192.168.1.240/28", "gateway": "192.168.1.1" }
    }
  }
}
```

`roles` binds plugin types to active implementations. `deploymentMode: "port"` validates against the enum but returns "not implemented until v1.1" at resolve time (veto item 2).

### 5.4 Service document

```json
{
  "schemaVersion": 1,
  "kind": "Service",
  "metadata": { "id": "jellyfin", "displayName": "Jellyfin" },
  "spec": {
    "deploy": {
      "plugin": "deploy-docker",
      "image": "jellyfin/jellyfin:10.9.11",
      "env": { "TZ": "America/Chicago" },
      "mounts": [
        { "type": "volume", "name": "jellyfin-config", "target": "/config" },
        { "type": "bind", "source": "/srv/media", "target": "/media", "readOnly": true }
      ],
      "devices": ["/dev/dri/renderD128"],
      "resources": { "memory": "4g" }
    },
    "expose": {
      "hostname": "jellyfin",
      "backendPort": 8096,
      "backendProtocol": "http",
      "isolationTier": "standard"
    }
  }
}
```

`spec.deploy` is validated by the deploy plugin's declared `configSchema`; `spec.expose` by core. `hostname` is a single label combined with `spec.domain` (subdomain mode).

### 5.5 Composed schema

The effective JSON Schema = core schema + each enabled plugin's `configSchema` mounted at its documented anchor (`spec.deploy` for the bound deploy plugin, `plugins/<id>.json` spec for plugin configs). The orchestrator publishes the composed schema to `wanfw_status/schema.json` after every plugin-set change; **Tier 1 renders forms from it** (schema-driven UI). This is the resolution of the brief's "schema can't be fixed at design time" flag: the schema is assembled at runtime from manifests, validated with Ajv in both tiers (Tier 1 for UX-time feedback, orchestrator authoritatively; Tier 1's validation is convenience, never trusted).

### 5.6 Versioning and migration

- Core documents: `schemaVersion` integer. The orchestrator ships pure migration functions `n -> n+1` and refuses documents *newer* than it knows (clear status error: "upgrade the framework").
- Plugin configs: the plugin manifest names a `migrations` entrypoint; the orchestrator invokes the plugin's `migrate(fromVersion, config)` task in the pluginhost (migrations are plugin code, so they run sandboxed like everything else).
- **Write-back protocol** (preserves the one-way write rule): the orchestrator never writes `wanfw_desired`. It uses migrated documents in memory and sets a per-document status flag `needsPersist: {toVersion}`. Tier 1 sees the flag, fetches the migrated document over the status socket, and persists it with its own write. Until then the system runs correctly on the in-memory migration; the flag nags in the UI.

---

## 6. Plugin System

### 6.1 Plugin types (v1)

| Type | Model | v1 built-ins |
|---|---|---|
| `deploy` | declarative (`plan` task) | `deploy-docker` |
| `network-provider` | declarative + `probe` | `network-bridge`, `network-macvlan` |
| `proxy-engine` | pure render (`render` task) + reload directive | `proxy-caddy` |
| `cert-issuer` | imperative session (ACME is interactive) | `cert-letsencrypt-dns01` |
| `dns-provider` | imperative, host-brokered callee | `dns-namecheap` |

More types are expected (auth-proxy, ddns, backup are known candidates); the manifest `types` field is an array so one bundle may implement several.

### 6.2 Manifest

```json
{
  "manifestVersion": 1,
  "id": "cert-letsencrypt-dns01",
  "version": "0.1.0",
  "frameworkApi": "^1.0",
  "types": ["cert-issuer"],
  "entrypoint": "dist/main.js",
  "runtime": "node22",
  "configSchema": "config.schema.json",
  "migrations": "dist/migrations.js",
  "capabilities": [
    { "cap": "dns.record.write", "scope": { "zones": ["${framework.domain}"] },
      "reason": "Create/remove _acme-challenge TXT records for DNS-01" },
    { "cap": "secrets.read", "scope": { "names": ["cert-letsencrypt-dns01/*"] },
      "reason": "ACME account key" },
    { "cap": "secrets.write", "scope": { "names": ["cert-letsencrypt-dns01/*"] },
      "reason": "Persist ACME account key on first run" },
    { "cap": "certs.store", "scope": {},
      "reason": "Deliver issued certificates to the proxy cert volume" },
    { "cap": "net.egress", "scope": { "endpoints": ["https://acme-v02.api.letsencrypt.org"] },
      "reason": "ACME API", "enforcement": "declared" },
    { "cap": "dns.query", "scope": {}, "reason": "Propagation checks" }
  ],
  "dependencies": {
    "settings": { "deploymentMode": "subdomain" },
    "roles": ["dnsProvider"]
  }
}
```

Notes:
- `${framework.domain}` style scope templates resolve against the framework document at grant time; the *resolved* scope is what gets recorded and signed. Re-templating on domain change requires re-grant (deliberate).
- `enforcement: "declared"` marks capabilities that are audited/displayed but not technically enforced in v1 (only `net.egress`; residual risk R2). The field exists so enforcement can be flipped on per-capability later without manifest churn.

### 6.3 Dependency resolution (brief §3, locked)

At enable time (role binding in the framework document, or plugin config activation), the orchestrator resolves the full dependency graph:

- `dependencies.settings`: required framework settings values (e.g., `deploymentMode: subdomain`).
- `dependencies.roles`: required role bindings (e.g., a `dnsProvider` must be bound).
- `dependencies.plugins` (reserved): direct plugin-id dependencies, for future non-role relationships.

Unsatisfied dependencies fail **at configuration time** with a structured status error naming exactly what is missing ("cert-letsencrypt-dns01 requires deploymentMode=subdomain; current: port"). Nothing activates partially; a role binding whose transitive dependencies fail is rejected atomically. Cycles are rejected. This is generic graph resolution, not DNS-01-shaped: the resolver knows nothing about specific capability names.

### 6.4 Lifecycle

```
stage (Tier 1 upload -> wanfw_staging, or built-in in image)
  -> trust (CLI: show manifest + capabilities, confirm; pin hash; copy to wanfw_bundles)
    -> grant (CLI: capabilities recorded with resolved scopes; part of the same trust prompt by default)
      -> enable (role binding / config activation; dependency resolution; composed schema republished)
        -> invoke (per reconcile / per schedule; hash-verified spawn in pluginhost)
  ...
untrust / revoke (CLI) -> plans referencing the plugin fail validation; status surfaces it
upgrade = stage new version -> trust new hash (diff of capability requests displayed) -> enable
```

### 6.5 Invocation protocol

Orchestrator to pluginhost over `orch-plugin.sock`, JSON-RPC 2.0:

```json
{ "method": "invoke", "params": {
    "invocationId": "uuid",
    "pluginId": "deploy-docker",
    "bundleHash": "sha256:...",
    "task": "plan",
    "input": { "service": { }, "context": { } },
    "grants": [ { "cap": "docker.device", "scope": { "paths": ["/dev/dri/*"] } } ],
    "limits": { "wallMs": 60000, "memMb": 256 }
} }
```

Pluginhost: verify bundle hash, spawn child (unprivileged uid, rlimits, `no-new-privileges`), speak JSON-RPC over the child's stdio. Child-originated host API calls are forwarded upstream tagged with `invocationId`; the orchestrator re-checks every call against the invocation's grants (the `grants` array in the job is informational for the plugin's own introspection; **the orchestrator's store is authoritative**, never the job payload). Timeout or nonzero exit fails the invocation; the reconciler surfaces it in status and retries with backoff.

Tasks by type: `deploy.plan`, `network.probe`, `network.plan`, `proxy.render`, `cert.ensure` (issue-or-renew for a set of names), `*.migrate`, `*.validate` (optional richer-than-schema validation, pure).

### 6.6 Host API (what plugin code may call)

All methods are capability-gated as noted; "own prefix" means namespaced by pluginId.

| Method | Gate |
|---|---|
| `state.get/put/delete(key)` | baseline, own namespace |
| `secrets.get(name)` | `secrets.read` scope match |
| `secrets.put(name, value)` | `secrets.write` scope match (own prefix is the norm) |
| `dns.setRecord(zone, rr)` / `dns.deleteRecord(...)` | `dns.record.write` zone scope; **brokered**: orchestrator forwards to the bound `dns-provider` plugin's `dns.apply` task |
| `dns.query(name, type, resolver?)` | `dns.query`; resolves in the pluginhost process space via an SDK-provided resolver (the orchestrator has no network, §2.4), with the call round-tripped to the orchestrator for logging; advisory (propagation timing), never a security decision |
| `certs.store(name, certPem, keyPem, meta)` | `certs.store`; orchestrator writes into `wanfw_certs` with 0640, triggers proxy reload pipeline |
| `ipam.allocate(rangeId)` / `ipam.release(ip)` | implicit for `network-provider` type; table lives in `wanfw_state` |
| `log.emit(level, msg, fields)` | always |

Deliberately absent: any raw Docker method. Docker effects exist only as declarative plan output (ADR-4). **Plugins never call each other**; cross-plugin needs (cert -> DNS) are brokered by the orchestrator through host API methods, which keeps every inter-plugin interaction on the mediated, logged, capability-checked path.

### 6.7 Plugin SDK

`@wanfw/plugin-sdk` (TypeScript): typed task handlers, host API client over stdio JSON-RPC, manifest type defs, test harness (`invokePluginForTest`) that fakes the host API with recorded grants so plugin repos can unit-test capability failures. Built-ins are the SDK's reference consumers.

---

## 7. Orchestrator Pipeline

Level-triggered reconcile loop; triggers: desired-state change (inotify/nudge), timer (60s), Docker events on `wanfw.managed` objects, scheduler (cert renewal), CLI actions.

```
load desired state -> envelope + schema validation (composed schema)
  -> migrate in memory if needed (flag needsPersist)
  -> dependency resolution (roles, settings, plugin deps)      [config-time errors out here]
  -> PLAN: for the framework + each service:
       network-provider.plan (endpoints, networks)
       deploy.plan (ContainerSpecs, attachments)
       route set assembly -> proxy-engine.render (proxy config artifact)
       cert requirements derived (names needed vs certs held)
  -> VALIDATE: field-level capability check of every emitted spec (§12.1),
       canonicalization (path normalization, symlink-free comparison for scope match),
       classification: routine | powerful (+ powerful projection hash)
  -> GATE: powerful without matching approval -> plan parked, status "pending approval",
       CLI command surfaced; routine (or strictApprovals=all satisfied) -> proceed
  -> EXECUTE: orchestrator applies primitives idempotently
       (ensure network -> ensure volume -> ensure container -> connect -> write proxy config
        -> docker exec proxy reload), each step journaled (planId, step, result) in wanfw_state
  -> OBSERVE: inspect managed objects, write status docs, GC labeled objects
       absent from desired state (containers first, then networks, volumes only if
       service doc set `removeVolumesOnDelete: true`; default keeps data)
```

Idempotency contract: `ensure*` primitives compare the live object's `wanfw.confighash` label; unchanged hash = no-op, changed = recreate (containers) or reconfigure where Docker allows. Crash mid-plan: the journal marks incomplete steps; the next reconcile re-plans from desired state and converges (no imperative replay). Concurrency: one reconcile at a time, queued triggers coalesce.

Cert scheduling: daily tick + on-demand when the route set introduces names not covered by held certs. Renewal threshold 30 days remaining; failure backoff 1h/4h/12h/daily with status escalation (§13).

---

## 8. Networking Design

### 8.1 Deployment modes

`subdomain` (v1): one wildcard cert `*.domain`, one stable proxy endpoint, Host-header routing. Rationale locked in brief (apps like Plex own `/`).
`port` (modeled, v1.1): per-service host port, per-name certs, no wildcard dependency; primarily for operators without a domain/DNS-API or with providers lacking DNS-01.

### 8.2 Providers

Per ADR-1. Wizard behavior: run `probe()` on all installed `network-provider` plugins; default to `network-bridge` when both pass unless the operator picks macvlan; print `operatorInstructions` from the chosen plan (exact port-forward: "forward WAN:443 -> 192.168.1.241:443" for macvlan, or "-> <host-LAN-IP>:443" for bridge). Note that the initial framework plan is itself powerful-tier (`docker.ports.publish` for bridge, `docker.network.provision` for macvlan), so `wanfwctl init` ends by rendering and approving that plan interactively; the proxy comes up as part of the wizard, not silently afterward.

### 8.3 DNS and WAN reachability (operator-facing, not automated in v1)

- Wizard detects the current WAN IP (via pluginhost helper hitting a plain what-is-my-ip endpoint, endpoint configurable) and prints: create `*.example.tld A <wan-ip>` (or the operator's DDNS name as CNAME target).
- Router port forwarding stays manual and explicit. **UPnP/NAT-PMP is rejected as a default** (silently opening WAN ports is the opposite of this project's philosophy); a future opt-in plugin may exist.
- DDNS is named as a future plugin type; out of v1.

### 8.4 Proxy plumbing

The proxy is dual-homed by construction: the exposure network (provider-planned) plus every `wanfw_svc_<id>` network. Health checks and config reloads therefore never depend on the exposure path: reload is `docker exec wanfw-proxy caddy reload --config /etc/caddy/Caddyfile` (a `docker.exec` capability scoped to the managed proxy, held by core on behalf of the proxy-engine flow), and health is HTTP over the service networks plus container state from Docker events. The macvlan host-hairpin caveat (host cannot reach the proxy's macvlan IP without a shim interface) is thereby a documentation item for operator debugging, not a functional dependency; docs include the `ip link add ... type macvlan` shim recipe for operators who want host-side curl tests.

### 8.5 Unknown Host handling

Caddy config includes a catch-all: any Host not in the route set gets a static 404 over TLS (wildcard cert), no backend contact, no default-site leak of service names.

---

## 9. TLS / Certificate Lifecycle

- ACME account: created on first `cert.ensure`; account key stored via `secrets.put("cert-letsencrypt-dns01/acme-account-key")`.
- Issue flow (DNS-01, wildcard `*.domain` + apex if configured): order -> `dns.setRecord(_acme-challenge TXT)` via broker -> propagation poll (`dns.query` against the zone's authoritative NS, then public resolvers; cap 10 min) -> finalize -> `certs.store` -> orchestrator sets `wanfw_certs/<name>/{fullchain.pem,key.pem}` 0640 root:proxygroup -> proxy reload -> `dns.deleteRecord` cleanup (always, including on failure paths).
- Renewal: threshold 30 days; jittered daily check; previous 3 cert generations retained for rollback (`wanfwctl cert rollback <name>`).
- Namecheap specifics: coarse account API key + client-IP allowlist; the DNS plugin surfaces the allowlist requirement in `probe`-style validation (it can detect 403s and say "add this host's WAN IP to Namecheap API allowlist"). Propagation on Namecheap can be slow; the poll interval/backoff is provider-plugin-tunable.
- Key custody note: the wildcard private key exists in exactly two places: `wanfw_certs` (orchestrator rw, proxy ro) and nowhere else. Quarantine tier (v1.1) never receives it (ADR-2 item 3).

---

## 10. Tier 1 (Frontend + BFFE) Specification

### 10.1 Scope

- Dashboard: services with state, endpoints, cert expiry, isolation tier; framework health.
- Service CRUD: schema-driven forms rendered from `wanfw_status/schema.json`; client-side Ajv validation for UX; writes atomic documents to `wanfw_desired`.
- Plugin management: list installed/trusted/enabled, upload bundle to staging, show manifests and capability grants (read-only), show pending-trust items **with the exact `wanfwctl` command to run**.
- Approvals view: pending powerful plans, human-rendered projections, copyable approve command. No approve button (ADR-6).
- Secrets view: names + set/unset + last-rotated only. No value entry (veto item 5).
- First-run page mirrors the wizard's operator instructions (port forward, DNS record, WAN IP) read-only.

### 10.2 Auth

Single admin account. Password set during `wanfwctl init`; the argon2id hash and session store live in `wanfw_tier1state` (tier1-private volume, §2.2). Sessions: HttpOnly, SameSite=Strict cookies; CSRF token on mutations; rate-limited login; no remember-me in v1.

### 10.3 Hardening checklist (LAN-threat standard, per ADR-7)

Non-root user, read-only rootfs, `no-new-privileges`, no capabilities, security headers (CSP without unsafe-inline, X-Frame-Options DENY), strict body-size limits, uploads (plugin bundles) size-capped and streamed to staging without parsing beyond hash, structured request logging. No TLS termination requirement on the LAN port in v1 (documented; operators can front it themselves), revisit with self-exposure.

---

## 11. CLI (`wanfwctl`) Specification

Host wrapper -> `docker exec -i wanfw-orchestrator wanfwctl-inner ...` -> admin.sock (§2.3). All commands audit-logged.

| Command | Purpose |
|---|---|
| `init` | Interactive wizard: probes providers, collects domain/email/provider creds, writes framework doc + secrets, trusts built-ins (with display), prints operator instructions |
| `status [service]` | Convergence state, pending items, cert expiries |
| `plugin list [--pending]` / `plugin show <id>` | Trust store + staged bundles |
| `plugin trust <id>@<hash> [--builtin-all]` | Display manifest + capabilities, confirm, pin, grant |
| `plugin untrust <id>` | Revoke trust (plans referencing it fail validation thereafter) |
| `grant list/show/revoke` | Capability grant management |
| `plan list [--pending]` / `plan show <id>` | Plans + powerful projections, human-rendered |
| `plan approve (--service <id> \| <projection-hash>)` | Record approval (banner for catastrophic content, ADR-4) |
| `plan revoke ...` | Remove approval; next reconcile parks the plan |
| `secret set/unset/list <name>` | Values via prompt or stdin only (no argv, no shell history) |
| `cert list/renew/rollback <name>` | Cert lifecycle overrides |
| `key show/rotate/import` | ADR-5 |
| `config set strictApprovals <powerful\|all>` | Approval strictness |
| `audit tail [--verify]` | Read audit log; verify hash chain + signatures |
| `doctor` | Environment probes: socket, iptables/nftables sanity, port conflicts, macvlan capability, DNS reachability |

Exit codes stable and documented (agent-facing: tests script against them).

---

## 12. Security Enforcement Details

### 12.1 Spec-field -> capability mapping (authoritative table for the validator)

| ContainerSpec field | Condition | Required capability (scope match) | Tier |
|---|---|---|---|
| `image` | always | `docker.image.pull` (repo glob; default grant `*` for deploy-docker) | baseline |
| `mounts[].type=volume` | name has `wanfw_` service prefix | `docker.volume.named` | baseline |
| `mounts[].type=bind` | always | `docker.mount.bind` (source path glob, ro/rw) | **powerful** |
| `devices[]` | always | `docker.device` (path glob) | **powerful** |
| `networkMode=host` | always | `docker.network.host` | **powerful** |
| `privileged=true` | always | `docker.privileged` | **powerful** (banner) |
| `capAdd[]` | always | `docker.capabilities` (cap list) | **powerful** |
| `ports[]` (host publish) | always | `docker.ports.publish` (port list/range) | **powerful** |
| `networks[]` | only `wanfw_svc_<own-id>` / plan-created | `docker.network.attach` | baseline |
| network create | mode in scope | `docker.network.provision` | **powerful** |
| `securityOpt`, `user`, `readOnly`, `env`, `cmd`, `resources`, `labels`, `restart` | always | none (constrained by schema) | baseline |

Validation rules: absolute-path canonicalization before glob match; bind sources compared after `realpath`-style resolution **of the configured path string** (no host FS access needed; reject `..` and non-absolute); device paths must match `/dev/*`; env values are opaque but keys matching `*_TOKEN|*_KEY|*_SECRET|PASSWORD*` trigger a status *warning* suggesting the secrets mechanism (warning only; not a gate). Core-emitted scaffolding (per-service networks, the proxy container, cert/proxycfg mounts into the proxy) executes under core authority, bypasses plugin grants, and is still journaled and audit-logged like everything else.

### 12.2 Powerful projection (normative)

`projection = { serviceId, image, mounts:[{source,target,ro}] (bind only), devices, networkMode, privileged, capAdd, publishedPorts }`, canonical JSON (sorted keys, sorted arrays), sha256. Approval records: `{ projectionHash, serviceId, humanRendering, approvedAt, keySig }`.

### 12.3 Audit log

Append-only JSONL in `wanfw_state`, hash-chained (`prevHash` field), Ed25519 checkpoint signature every 100 entries and on every security-relevant entry (trust, grant, approve, key op, powerful execute, secret set). `wanfwctl audit tail --verify` recomputes the chain. Tamper-evident against post-hoc editing; not tamper-proof against P6 (stated, accepted).

### 12.4 Secrets handling

Files under `wanfw_secrets/<pluginOrCore>/<name>`, 0600, dir 0700. Injected into plugin invocations **by value at invoke time** only when the grant covers them; never mounted into the pluginhost; never present in Tier 1's reachable surface (which is why entry is CLI-only, veto item 5: a value typed into Tier 1 transits the designated-compromised tier). Rotation = `wanfwctl secret set` + affected containers bounced by the next reconcile (brief's accepted tradeoff).

### 12.5 Compose-level assertions (shipped as tests)

Integration tests assert, from inside each container: tier1 cannot stat the socket, cannot connect to admin.sock, cannot open `wanfw_state`/`wanfw_secrets`; pluginhost cannot stat the socket; orchestrator has no network interfaces beyond loopback; a tampered bundle byte fails invocation.

### 12.6 Container hygiene (all framework containers)

Non-root users, `no-new-privileges`, `cap_drop: [ALL]` plus explicit adds only where required, read-only rootfs with tmpfs for scratch, pinned image digests in the published compose file, healthchecks.

---

## 13. Observability and Failure Handling

- Status documents per service: `phase` (pending | reconciling | live | degraded | pending-approval | error), endpoints, cert `notAfter`, last error (structured: stage, plugin, message), `needsPersist` flags.
- Structured JSON logs to stdout on all three framework containers (docker logs is the log pipeline; no log stack shipped).
- Failure behaviors: plugin invocation failure -> plan fails, backoff retry (30s * 2^n cap 15m), status degraded; Docker daemon unavailable -> reconciler idles with status error; cert renewal failing with < 7 days remaining escalates status to `degraded` framework-wide (the one alarm that must be impossible to miss in the UI); partial execution -> journal + reconverge (§7).
- `wanfwctl doctor` covers the "why doesn't WAN reach me" triage: port listen check, WAN IP vs DNS record, hairpin note for macvlan.
- Webhook/email alerting: post-MVP (§16).

---

## 14. Tech Stack and Repository Layout

- **Language:** TypeScript throughout, Node 22 LTS, ESM, `strict` tsconfig.
- **Orchestrator:** plain TS (no web framework; it serves two Unix sockets), `dockerode` for the Docker API, `better-sqlite3`, `ajv` (JSON Schema 2020-12), `chokidar` for watch, Ed25519 via `node:crypto`.
- **Pluginhost:** plain TS supervisor; `child_process.spawn` with uid/gid drop, rlimits via `prlimit` wrapper or spawn options.
- **Tier 1:** Fastify BFFE + React/Vite UI, `@rjsf` or hand-rolled schema-driven forms over Ajv. (NestJS acceptable substitute if the implementing agent prefers; BFFE surface is small either way. Chosen for footprint, not conviction.)
- **CLI:** plain TS, `commander`, talks JSON over admin.sock; distributed inside the orchestrator image + host wrapper script.
- **Proxy:** `caddy:2.x` pinned digest, config rendered by `proxy-caddy` as a Caddyfile (JSON config acceptable if templating gets awkward; pick one, don't support both).
- **Monorepo:** pnpm workspaces.

```
/packages
  core-schemas/      # envelope, framework, service, expose schemas; capability taxonomy constants
  orchestrator/
  pluginhost/
  plugin-sdk/
  tier1-api/
  tier1-ui/
  wanfwctl/
/plugins
  deploy-docker/
  network-bridge/
  network-macvlan/
  proxy-caddy/
  cert-letsencrypt-dns01/
  dns-namecheap/
/deploy
  docker-compose.yml
  install.sh           # pulls, up, prints init instructions
/docs
  operator-guide.md  threat-model.md  plugin-authoring.md
/test
  integration/         # compose-level assertions (§12.5), e2e with pebble + mock DNS
```

Testing: unit (vitest) per package; plugin tests via SDK harness; **e2e against Pebble** (Let's Encrypt's test ACME server) and a mock `dns-provider` plugin, so the full DNS-01 wildcard flow runs in CI with no real domain; one manual staging-LE runbook doc for release validation.

---

## 15. Milestones (implementation order, each with acceptance criteria)

**M0: Skeleton.** Monorepo, compose stack boots (tier1 hello + login, orchestrator loop no-op writing heartbeat status, pluginhost idle), `wanfwctl status` round-trips, §12.5 negative assertions pass in CI.

**M1: Plugin runtime + trust.** Manifest loading, trust store + hash pinning, grant store, admin socket + CLI (`plugin trust/list`, `grant`), pluginhost spawn/RPC/limits, host API skeleton (`state`, `log`), an `echo` test plugin; tests: tampered bundle refused, out-of-grant host call rejected, timeout kill works.

**M2: Reconciler + deploy path, LAN-provable.** Desired-state watch + composed-schema validation, `deploy-docker` + `network-bridge` + `proxy-caddy` plugins, per-service networks, field-level validator + tiering + projection hashing + approval gate + CLI `plan approve`, journal + GC. Caddy runs with its internal CA for this milestone only (self-signed, LAN test). AC: add/modify/remove a service end to end on LAN; powerful plan blocks until approved; GC leaves nothing labeled behind.

**M3: Real certs.** `cert-letsencrypt-dns01` + `dns-namecheap`, secrets flow, renewal scheduler, Pebble e2e in CI, staging-LE manual runbook. AC: wildcard issued, proxy serves it, renewal path exercised (Pebble short-lived certs), TXT cleanup verified including failure paths, §1.2 full acceptance scenario passes on a real domain.

**M4: Macvlan + wizard.** `network-macvlan` (probe, IPAM, static IP), `wanfwctl init` full wizard (provider probe/choice, WAN IP detect, instructions), `doctor`. AC: §1.2 scenario passes in macvlan mode on real hardware; probe correctly declines on a VPS-like environment (veth test rig).

**M5: Hardening + docs.** Audit chain + `audit tail --verify`, catastrophic-grant banners, `strictApprovals: all` mode, container hygiene pass (§12.6), operator guide, threat-model doc (§3 published), plugin-authoring guide, key rotate/import. AC: negative acceptance list in §1.2 passes; fresh-machine install following only the operator guide succeeds.

**v1.1 (next release, pre-scoped):** quarantine tier execution (ADR-2: dedicated proxy purpose, per-name certs, multi-proxy config mgmt), port-based deployment mode, adopt-existing evaluation (§16).

---

## 16. Deferred Items and Non-Goals (restated + additions)

From the brief, unchanged: no PaaS lifecycle management; no auth/SSO for exposed services (plugin seam preserved: an auth-proxy plugin type slots between route assembly and render); single host, Compose only; no Podman/k8s/bare-metal.

Added deferrals with reasons:
- **Adopt existing containers** (ADR-9): ownership split-brain; revisit v1.1+ with an explicit "reference-only" mode (route to an unmanaged backend by IP:port, no lifecycle claims) which avoids the ownership problem entirely and may be the better feature.
- **Port-based mode** (veto 2): v1.1 with quarantine (they share per-name cert machinery).
- **Egress enforcement per plugin** (R2): v2 substrate work (netns or WASM), interface already stable.
- **DDNS, UPnP-opt-in, webhook alerting, GitOps sync, registry-signed plugins:** named so the plugin taxonomy and trust code keep their seams; none in v1.
- **Framework self-update:** out of scope; compose pull is the update story, migrations handle the data (§5.6).

---

## Appendix A: Compose sketch (normative for mounts/isolation, illustrative otherwise)

```yaml
services:
  tier1:
    image: wanfw/tier1:<digest>
    networks: [wanfw_admin]
    ports: ["8443:8443"]        # LAN interface binding documented; operator may pin host IP
    volumes:
      - wanfw_desired:/data/desired
      - wanfw_status:/data/status:ro
      - wanfw_staging:/data/staging
      - wanfw_rpc_status:/run/wanfw   # orch-status.sock only; never the plugin socket
      - wanfw_tier1state:/data/state
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    read_only: true
    tmpfs: [/tmp]

  orchestrator:
    image: wanfw/orchestrator:<digest>
    network_mode: "none"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - wanfw_desired:/data/desired:ro
      - wanfw_status:/data/status
      - wanfw_staging:/data/staging:ro
      - wanfw_bundles:/data/bundles
      - wanfw_state:/data/state
      - wanfw_secrets:/data/secrets
      - wanfw_certs:/data/certs
      - wanfw_proxycfg:/data/proxycfg
      - wanfw_rpc_status:/run/wanfw/status
      - wanfw_rpc_plugin:/run/wanfw/plugin
    security_opt: ["no-new-privileges:true"]

  pluginhost:
    image: wanfw/pluginhost:<digest>
    networks: [wanfw_egress]    # outbound only; no published ports (R2)
    volumes:
      - wanfw_bundles:/data/bundles:ro
      - wanfw_rpc_plugin:/run/wanfw
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    read_only: true
    tmpfs: [/tmp]

networks:
  wanfw_admin: {}
  wanfw_egress: {}

volumes:
  wanfw_desired: {}
  wanfw_status: {}
  wanfw_staging: {}
  wanfw_bundles: {}
  wanfw_state: {}
  wanfw_secrets: {}
  wanfw_certs: {}
  wanfw_proxycfg: {}
  wanfw_rpc_status: {}
  wanfw_rpc_plugin: {}
  wanfw_tier1state: {}
```

The proxy and `wanfw_svc_*` networks/containers are orchestrator-created, not in this file (ADR-9, §2.1).

## Appendix B: Traceability to brief

| Brief item | Resolution |
|---|---|
| §2 Tier 1 / Tier 2 split, socket custody | §2, ADR-3 (Tier 2 split into two containers, socket unchanged: one holder) |
| §2 signing key Tier 1 can't access | ADR-5 |
| §3 plugin categories + dependency manifests + config-time errors | §6.1 to §6.3 |
| §3 plugin-aware schema | §5.5 |
| §3 config versioning/migrations | §5.6 |
| §4 MVP scope (LE DNS-01, Namecheap, Caddy-as-plugin, subdomain default, Compose-only, volume secrets, auth deferred) | §4 ADR-8, §6, §8.1, §12.4, §16 |
| §5.1 macvlan | ADR-1 |
| §5.2 quarantine | ADR-2 |
| §5.3 trust chain / capabilities / isolation / key custody | ADR-3, ADR-4, ADR-5, ADR-6, §12 |
| §5.4 admin access | ADR-7 |
| §6 non-goals | §16 |
| §7 philosophy (secure defaults, loud escape hatches, Plex-easy sanity check) | ADR-4 banners, §1.2/§1.3 acceptance, R1 strict mode |
