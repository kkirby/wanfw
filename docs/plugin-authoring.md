# Writing a wanfw plugin

wanfw plugins are declarative: they run in the pluginhost container (which has *no* Docker socket access of any kind, ADR-3) and emit *plans* -- descriptions of what Docker objects should exist. The orchestrator, not the plugin, validates every field of that plan against the plugin's own granted capabilities and actually calls Docker. A plugin, however malicious or however badly its config is abused, cannot cause anything the orchestrator's field-by-field validator wouldn't independently allow (see `docs/threat-model.md`, guarantees G2/G5/G7).

If you're extending an existing built-in (say, adding a new DNS provider alongside `dns-namecheap`), read an existing plugin under `plugins/` first -- this doc explains the shapes, but the built-ins are the canonical, currently-shipping examples.

## 1. Plugin types

A manifest's `types` array names which role(s) it can fill:

- `deploy` -- turns a service document into a Docker `ContainerSpec`. Built-in: `deploy-docker`.
- `network-provider` -- probes host network feasibility and plans the shared exposure network. Built-ins: `network-bridge`, `network-macvlan`.
- `proxy-engine` -- renders reverse-proxy config from the route list. Built-in: `proxy-caddy`.
- `cert-issuer` -- ensures TLS certs exist for a set of names. Built-in: `cert-letsencrypt-dns01`.
- `dns-provider` -- applies DNS record changes (used by cert issuance for DNS-01). Built-in: `dns-namecheap`.

A single plugin can declare more than one type if its tasks genuinely span roles, though every built-in so far sticks to exactly one.

## 2. The manifest

Every plugin ships a `manifest.json` (validated against `packages/core-schemas/src/schemas/manifest.schema.json`):

```json
{
  "manifestVersion": 1,
  "id": "network-bridge",
  "version": "0.1.0",
  "frameworkApi": "^1.0.0",
  "types": ["network-provider"],
  "entrypoint": "main.js",
  "runtime": "node22",
  "capabilities": [
    { "cap": "docker.ports.publish", "scope": { "ports": [80, 443] }, "reason": "publish the shared proxy's 80/443 on the host", "enforcement": "enforced" }
  ]
}
```

- `id`: lowercase, `[a-z0-9][a-z0-9-]*`. This is also the plugin's directory name and the identifier used everywhere it's referenced (framework doc roles, trust records, grants).
- `version`: semver, plain `x.y.z`.
- `frameworkApi`: a caret range against the framework API version this plugin was written for.
- `entrypoint` / `runtime`: currently always `main.js` / `"node22"` -- the pluginhost spawns a bare Node 22 process with **no `node_modules` alongside it**, so your entrypoint (and everything it imports) must be self-contained compiled JS, no runtime `require`/`import` of third-party packages. See §5.
- `configSchema` (optional): a path to a JSON Schema file validating this plugin's own config block in the framework/service document, if it has settings beyond capabilities.
- `capabilities`: every host API capability this plugin might invoke, each with a `reason` (shown to the operator at trust time, ADR-5) and `enforcement`: `"enforced"` (the orchestrator checks the scope on every call) or `"declared"` (visibility only, e.g. `net.egress` -- see `docs/threat-model.md` R2 for why declared-only enforcement is an accepted v1 gap, not an oversight).

**Capability scopes are the actual security boundary**, not the manifest text. A `docker.mount.bind` capability scoped to `{"paths": ["/media/*"]}` cannot be used to bind-mount `/var/run/docker.sock`, no matter what the plugin's code tries to do -- the orchestrator checks the *emitted plan's* mount source against the *stored* grant's scope on every single invocation (`packages/orchestrator/src/validate/validate-plan.ts`), never trusting the plugin's own claims about itself.

## 3. Task contracts

A plugin registers task handlers by method name and responds to NDJSON-framed JSON-RPC 2.0 requests over stdin/stdout -- one JSON object per line, no batching. Minimal hand-rolled loop (this is exactly what every built-in does; there's no framework magic hiding it):

```ts
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line) as { id: unknown; method: string; params?: unknown };
  if (req.method === "network.plan") {
    const result = planTask(req.params);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no such task: ${req.method}` } })}\n`);
});
```

Task names by plugin type (input/output shapes in `packages/plugin-sdk/src/task-types.ts`, kept intentionally loose -- `JsonValue` payloads -- since each owning plugin firms up its own actual contract):

| Type | Task | Purpose |
|---|---|---|
| `network-provider` | `network.probe` | Real feasibility check (e.g. "can a macvlan network actually be created on this interface?") -- mediated by the orchestrator's `net.probeNetwork` host API (a real, throwaway Docker network create+delete under core authority), never direct Docker access. |
| `network-provider` | `network.plan` | Emits the shared exposure network's shape: driver, resources (name/parent/IPAM for macvlan), endpoint (host-ports for bridge, dedicated address for macvlan), properties (`hostIsolated`, `dedicatedL2`, `hairpinCaveat`). |
| `deploy` | `deploy.plan` | Turns a service document's `deploy` block into a `ContainerSpec` (image, mounts, devices, env, network mode, etc.) -- this is the plan the orchestrator's field-by-field validator (§12.1) actually gates. |
| `proxy-engine` | `proxy.render` | Turns the route list (hostname -> backend network/port) into rendered proxy config (a Caddyfile, for `proxy-caddy`) plus a reload directive. |
| `cert-issuer` | `cert.ensure` | Given a set of names, ensures valid certs exist (ACME DNS-01 flow for `cert-letsencrypt-dns01`), storing them via the orchestrator's cert store -- never holding them itself beyond issuance. |
| `dns-provider` | `dns.apply` | Applies a DNS record change (used by DNS-01 challenge records). |

## 4. The host API

Task handlers receive a `HostApiClient` (`packages/plugin-sdk/src/host-client.ts`) as their second argument -- the *only* way a plugin reaches anything outside its own process. Every call is checked against this plugin's stored grants before it does anything (never against what the invocation payload itself claims, invariant #8 in the implementation plan). If your plugin needs a capability, declare it in the manifest with a reason; if it's not granted at trust time, the call fails, loudly, at the host API layer -- not somewhere downstream.

Do not attempt to import `dockerode`, `node:net` against the Docker socket, or anything else that reaches Docker directly -- the pluginhost container has no socket to reach (ADR-3); it will simply fail, by design, not as a bug to work around.

## 5. Build and packaging

Built-ins are compiled at image-build time and copied into the pluginhost image's `builtins/` directory (see `deploy/pluginhost.Dockerfile`) -- no `npm install` happens inside the running container, ever. Third-party plugins are distributed as a `.tar` of a directory containing (at minimum) `manifest.json` and the compiled `entrypoint` file plus any compiled siblings it imports -- no `node_modules`. If your plugin needs a third-party npm dependency, bundle it (esbuild, or similar) into a single compiled file at your own build step; don't ship a `package.json` expecting the pluginhost to install anything.

Each plugin directory also needs a `{"type":"module"}` `package.json` alongside its compiled output so Node treats it as ESM without re-sniffing syntax on every invocation (a real, if minor, startup-cost fix found during T4.7 -- see PROGRESS.md).

## 6. The trust flow

1. Upload the plugin bundle (a `.tar`) via tier1's Plugins page. It's streamed to a staging directory and hashed (`sha256` of the extracted directory tree) -- never parsed or executed beyond that hash.
2. Review the manifest tier1 shows you: every capability it's requesting and the stated reason for each.
3. Trust it explicitly on the host:

```sh
wanfwctl plugin trust <id>@<sha256> --yes
```

From that point, the plugin's grants live in `wanfw_state` (orchestrator-private, no shared volume) and every subsequent invocation is checked against exactly those grants. Untrusting (`wanfwctl plugin untrust <id> --yes`) makes any plan referencing it fail validation from then on. A tampered bundle -- one whose content no longer matches the hash it was trusted under -- is refused loudly at load time, not silently substituted.

## 7. Testing your plugin

Manually invoke a trusted plugin's task for debugging (this is exactly what the reconciler does automatically once your plugin is wired into a framework role):

```sh
wanfwctl plugin invoke <id> <task> '{"...":"..."}'
```

For real automated tests, follow the pattern every built-in already uses: a NDJSON-loop unit test spawning the compiled `main.js` as a child process and asserting on request/response pairs (see `plugins/network-bridge/src/index.test.ts` for the shape), plus the orchestrator-side `plan-stage.test.ts` / `gate-stage.test.ts` fixtures if your plugin introduces a new field the validator needs to know about.
