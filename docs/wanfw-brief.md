# Handoff Brief: Composable Self-Hosted WAN Exposure Framework

**Purpose of this document:** This is a scoping brief, not the final spec. It captures locked decisions, open design questions, and explicit non-goals from a scoping conversation.

**Your task:** produce a complete technical specification and system design for this framework, detailed enough that a coding agent can implement it directly from your output without further architectural decisions being deferred to implementation time. That means, at minimum:

- Resolve each item in §5 (Open Design Questions) with a concrete decision and stated rationale — not a menu of options left for the implementer to pick from. Where a question genuinely has no clean answer, pick the best tradeoff and say why, rather than passing the ambiguity downstream.
- Define concrete schemas: plugin manifest format, config file format (with versioning/migration strategy), the Tier 1 ↔ Tier 2 interface, the plugin ↔ Tier 2 mediated API (per §5.3).
- Define the repo/module structure, the plugin interface (as actual function signatures / types, not prose), and how a third-party plugin author would build and register one.
- Define the Compose file structure for the three-tier deployment described in §2.
- Call out any part of this brief you think is wrong, underspecified, or in tension with itself — do not silently resolve contradictions by picking one side without flagging it.

Output should be structured as a spec document an implementing agent can work from top to bottom, not a discussion of tradeoffs. Where you're making a judgment call beyond what's specified here, state it explicitly as a decision, not an assumption buried in the design.

---

## 1. Problem Statement

Self-hosted homelab operators who want to expose Docker services (Plex, Jellyfin, Kavita, etc.) to the WAN over HTTPS currently face two bad options: a single shared reverse proxy with broad Docker socket / host-network access (high blast radius if compromised), or a fully isolated proxy-per-service pattern (macvlan IP + dedicated TLS-terminating proxy per container) that doesn't scale operationally — every new service means a new IP, new cert lifecycle, new router rule.

The goal is a generic, pluggable, self-hostable framework that gives operators safe WAN exposure of arbitrary Docker services, with sane secure defaults, without requiring bespoke per-service network engineering.

---

## 2. Core Architecture (Locked)

Three logical components, deployed together via a single Docker Compose stack on one host (MVP scope — see Non-Goals):

### Tier 1 — Frontend + BFFE (Backend-for-Frontend)
- Serves the web UI
- Owns all "business logic": plugin configuration, validation, schema enforcement, user-facing API, plugin capability grant UI
- **No Docker socket access, ever**
- Writes configuration to a shared store (file or DB) that Tier 2 reads
- This is the component most likely to be exposed to any admin-facing surface (LAN at minimum; WAN admin access is an open question, see §5)

### Tier 2 — Deploy Backend / Orchestrator
- Independently reads the configuration Tier 1 writes
- Runs the orchestration pipeline: passes config through the relevant plugins to produce the actual Docker actions (container creation, network attachment, proxy config generation, etc.)
- **Holds the Docker socket** — this is the only component that does
- Ingress only from Tier 1 (localhost-bound or Unix socket; not network-exposed)
- Holds a signing key that Tier 1 does not have access to (see §5, plugin trust chain)
- Deploys and manages the reverse proxy container itself, including macvlan attachment where applicable

### Data plane — Reverse Proxy
- Deployed and managed by Tier 2, not Tier 1
- Terminates TLS, routes to backend service containers
- MVP: single proxy instance (Caddy), subdomain-based routing via wildcard cert (see §3)

**Explicit rationale for the Tier 1 / Tier 2 split:** A compromise of Tier 1 (the web-facing component with the larger attack surface — HTTP handling, auth, request parsing) should not translate directly into Docker socket access. Tier 2's independent, read-based reconciliation model (rather than accepting arbitrary payloads from Tier 1) is a deliberate mitigation — see §5 for the unresolved part of this (plugin trust and capability limits).

---

## 3. Plugin Architecture (Locked Direction, Open Details)

Two plugin categories identified so far, likely more:

1. **Certificate acquisition plugins** — e.g., Let's Encrypt via DNS-01 (MVP). Future: HTTP-01, other CAs.
2. **DNS provider plugins** — required dependency of any cert plugin using DNS-01. MVP: Namecheap. Should be designed against a broad interface (Lego-compatible providers were discussed as a reference point) so other providers are drop-in, not bespoke.
3. **Deploy/orchestration plugins** — turn validated config into Docker actions (container definitions, network attachments, proxy config generation). This is likely the core plugin type Tier 2's pipeline executes.

**Deployment mode is a first-class, cert-plugin-relevant setting:** subdomain-based (wildcard cert, one proxy IP, `Host`-header routing — preferred default) vs. port-based (per-service port forward, no wildcard cert dependency). A cert plugin using DNS-01 has a hard dependency on subdomain mode + a configured DNS provider plugin.

**Dependency declaration (locked):** Plugins declare required capabilities/dependencies (e.g., "requires deployment_mode=subdomain" + "requires a DNS provider plugin") via a manifest. The system must refuse to enable/activate a plugin until its declared dependencies are satisfied — surfaced as a configuration-time error, not a runtime failure. This should extend to the full plugin dependency graph, not just the DNS-01 case, since more plugin types are expected long-term.

**Config schema must be plugin-aware:** the schema can't be fully fixed at design time since it needs to reflect what capabilities/fields are actually available given which plugins are installed/enabled. Punting exact mechanism to design phase — flagged as needing real design thought, not a simple static schema.

**Config versioning:** the schema needs a version field and a migration story from the start, since plugin updates changing their config shape is expected over the framework's life, not an edge case.

---

## 4. MVP Scope Decisions

- **Cert plugin:** Let's Encrypt via DNS-01 only.
- **DNS provider plugin:** Namecheap only, but built against a generic interface.
- **Proxy engine:** Caddy only (chosen over Traefik/Nginx for smaller/cleaner codebase, strong current security scrutiny, clean config model). Should still be implemented as a swappable plugin type, not hardcoded, since "someone builds an Nginx + HTTP-01 plugin later" is an explicit target use case.
- **Routing mode default:** subdomain-based via wildcard cert (`*.yourdomain.tld`). Rationale: apps like Plex that don't support a configurable root path / URL prefix break under path-based routing; subdomain routing sidesteps this entirely since each backend still thinks it owns `/`.
- **Deployment target:** Docker Compose only. Frontend, BFFE, and backend must run in the same Compose stack, same host, for MVP — no distributed/multi-host deployment. Isolation between components is via Docker networking (Tier 1 has no path to the Docker socket; Tier 2 is not network-exposed beyond Tier 1), not host separation.
- **Secrets:** Docker volume (not named volume with broad access — scoped appropriately, root-only, no world access). Accepted tradeoff: rotating secrets requires bringing containers down and back up. No external vault/KMS integration in MVP.
- **Auth/SSO:** explicitly out of MVP scope, but the plugin architecture should be sturdy enough that auth could plausibly be added later as a plugin (e.g., an auth-proxy-in-front-of-services plugin) without a rearchitecture. Not a v1 deliverable.

---

## 5. Open Design Questions (Not Yet Resolved — Highest-Value Design Work)

These are explicitly unresolved. Do not silently pick a default and move on — these tradeoffs were identified as consequential and deserve real design reasoning.

### 5.1 Macvlan: first-class citizen or plugin?
Originally the selling-point architecture (per-exposed-service or shared-proxy macvlan IP for network-layer isolation from the host). Unresolved whether macvlan should be baked into the core architecture or itself be a pluggable network-isolation strategy, with a lesser fallback (e.g., bridge network + host port mapping) for platforms without macvlan support (VPS environments, certain cloud/virtualized setups). If it becomes a plugin, the plugin interface needs to be designed generically enough that the framework isn't secretly macvlan-shaped underneath a thin abstraction — i.e., don't design the "generic" interface around macvlan's specific capabilities and call other backends second-class.

### 5.2 Quarantine tier (proxy-per-container isolation)
Should fully-isolated per-container proxy+macvlan deployment (for untrusted/high-risk services) be automated by the framework as a selectable tier, or remain an intentional manual escape hatch outside the tool's automated scope? Leaning toward automated tier as a real feature, not just documentation, but unresolved.

### 5.3 Plugin trust chain and capability isolation — the core unresolved security question
This is the most consequential open item. Summary of the reasoning that led here, for context:

- Tier 2 independently runs the orchestration plugin pipeline against config that Tier 1 (the more web-exposed, larger-attack-surface component) writes.
- A compromised Tier 1 could write malicious *configuration* that a legitimate, unmodified, "trusted" plugin then faithfully executes — e.g., a config entry requesting a Docker socket bind-mount into a new container, or `--privileged`, via a real DNS/cert/deploy plugin just doing its job on bad input.
- Signing plugins (Tier 2 holds a signing key Tier 1 cannot access; plugins must be signed before Tier 2 will load them) solves *code substitution* — a compromised Tier 1 can't smuggle in new malicious plugin code. It does **not** solve *malicious config interpreted by honest, signed plugin code*. These are separate problems and both need addressing.
- The proposed direction (needs real design work, not just adoption): a **capability-based permission model**, analogous to Tampermonkey / browser extension manifests / Deno's permission system. Plugins declare required capabilities in a manifest (network attach, volume mounts scoped to specific allowed paths, env var access, etc.). Tier 2 exposes a **mediated API** to plugin code rather than direct Docker socket access — plugin code calls host-provided functions, and Tier 2 checks the call against the plugin's granted capabilities before executing anything against Docker. The plugin should have no code path capable of expressing "mount the Docker socket" unless that specific capability was explicitly granted.
- **Isolation mechanism for plugin code execution (JS-specific) is unresolved and should be evaluated as options, not pre-decided:**
  - Node `vm`/`vm2`-style in-process sandboxing — weakest isolation, known history of sandbox-escape CVEs in similar libraries, probably inadequate given Docker socket proximity
  - Worker threads with a strict message-passing API (no shared memory, only explicitly wired calls) — moderate isolation, more robust than in-process `vm`
  - Separate child process per plugin communicating over a defined RPC surface — strongest practical isolation, closest to how browser extension / Tampermonkey sandboxing actually works, more operational overhead
  - WASM-compiled plugins with a capability-scoped host API (WASI-like model) — strongest sandboxing, heaviest lift for plugin authors
- **Explicit constraint that must be reconciled against the above:** the capability model must NOT become so restrictive that real-world deployments become inexpressible. Target use cases explicitly include things like Plex/Jellyfin with hardware transcoding (device access), and potentially host networking for discovery protocols (DLNA, etc.) — arbitrary, powerful Docker options need to be reachable by plugins so any valid container can be formed. **The security boundary should come from what capability is granted per plugin install (explicit, visible, revocable, loud when powerful) — not from what's technically expressible by the API.** Nothing should be silently unavailable; powerful grants should be visible and require explicit user approval, similar to mobile OS permission models. If a user wants to grant a plugin `--privileged` + host networking, that must be possible, but as a deliberate, visible act, not a silent default or an API limitation.
- **Key custody for the Tier 2 signing key is also unresolved:** generated at install time? User-supplied? Self-signed-by-operator acceptable for MVP (explicitly floated as acceptable), but the actual mechanism needs design.

This entire section (§5.3) is the primary piece of hard design thinking this task needs. Everything else in this brief is reasonably well-scoped; this is not.

### 5.4 Admin access model
Not yet discussed in depth: is Tier 1 (frontend/BFFE) ever intended to be WAN-accessible for remote admin, or LAN/VPN-only by design? This affects whether Tier 1's own attack surface needs to be hardened to the same degree as the exposed application containers it's managing.

---

## 6. Explicit Non-Goals (MVP)

- Not a full PaaS — does not manage general container lifecycle/updates beyond what's needed for the proxy + configured services.
- Not handling authentication/SSO for exposed services — plugin architecture should make this addable later, but it's not a v1 deliverable.
- Not supporting multi-host or distributed deployment — single Compose stack, single host, for v1.
- Not supporting non-Docker deployment targets (no bare CLI-only, no Podman, no k8s) for v1.
- Not solving plugin sandboxing to a fully hardened degree in v1 necessarily — but the plugin *interface* must be designed so isolation (per §5.3) can be retrofitted without an API-breaking rearchitecture, even if v1 ships with a lighter-weight implementation.

---

## 7. Design Philosophy Notes (for context, not requirements)

- The operator explicitly wants to avoid the "WordPress plugin sprawl" failure mode — acknowledged as a real risk given how pluggable this is trying to be, but the goal is still broad pluggability with good architectural bones, not a minimal fixed feature set.
- Preference throughout has been for defaults that are secure without requiring the operator to think hard about it, while still keeping an escape hatch for operators who want to do something more permissive/custom (with that permissiveness made explicit and visible, not silent).
- The reference/motivating use case throughout has been: "run something like Plex or Jellyfin with TLS, fronted by a proxy that routes to isolated containers" — safely, with minimal per-service manual network engineering. Every architectural decision should be sanity-checked against whether it still makes that use case easy, not just theoretically secure.
