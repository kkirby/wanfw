# wanfw

A composable, self-hosted framework for exposing your own Docker services (Jellyfin, Kavita, Plex, whatever) to the WAN over automatic HTTPS -- without handing the exposed side of your stack a shared reverse proxy that also happens to hold your Docker socket.

Add a service through a web UI, review and approve anything that asks for real host access (a bind mount, a device, host networking) with one copyable CLI command, and get a working `https://service.yourdomain.tld` with a real Let's Encrypt certificate. Nothing is silently blocked -- powerful grants just require a deliberate, visible approval, and the worst ones (Docker socket access, `privileged`, raw disk devices) get an unmissable banner first.

## Why

The usual options for self-hosted WAN exposure are a single shared proxy with broad access (one compromise away from the whole host) or a fully isolated proxy-per-service setup (a new IP, cert, and router rule for every container). wanfw is the middle path: one shared framework, but every deployed service gets its own isolated network, and every action that could actually compromise the host is gated behind an explicit, out-of-band approval -- enforced by the one component with real Docker access, not just requested by the UI.

## How it's built

Three containers, one Docker Compose stack, deliberately drawn trust boundaries:

- **tier1** -- the web UI. LAN/VPN-only by design. Can *propose* changes (add a service, request a bind mount) but has zero path to the Docker socket, admin credentials, or plugin execution -- it can't cause anything to actually happen on its own.
- **orchestrator** -- the only container holding `/var/run/docker.sock`. Otherwise has no network of its own (`network_mode: none`). Every security-relevant mutation (trust, grants, approvals, secrets) lives behind its own admin socket, on no shared volume. Validates every plugin-emitted plan field-by-field against that plugin's actual granted capabilities before ever touching Docker.
- **pluginhost** -- runs plugin code (network providers, DNS providers, cert issuers, deploy drivers). No Docker socket access of any kind. Plugins emit declarative plans; they never call Docker directly.

See `docs/threat-model.md` for the full adversary model and what's actually guaranteed vs. accepted as a residual risk.

## Quickstart

```sh
git clone <this repo> wanfw && cd wanfw
docker compose -f deploy/docker-compose.yml up -d --build
alias wanfwctl='docker exec -i wanfw-orchestrator wanfwctl-inner'
wanfwctl init
```

The wizard asks for your domain, DNS provider credentials, and ACME email, then prints the exact DNS record and port-forward instructions plus a one-time setup token for tier1's web UI (`http://<host-LAN-IP>:8443/setup`).

Full walkthrough, including adding a service and the approval workflow, in **`docs/operator-guide.md`**.

## Repo layout

```
packages/
  core-schemas/     shared JSON Schemas, canonical JSON, hashing -- the wire contracts everything else depends on
  orchestrator/      the only Docker-socket-holding component; reconcile pipeline, host API, trust/grant/approval flow
  pluginhost/        spawns and supervises plugin child processes; zero Docker access
  plugin-sdk/         types + a thin host-API client for plugin authors
  tier1/              the web UI (Next.js)
  wanfwctl/            the operator CLI, runs inside the orchestrator container
plugins/
  deploy-docker/       turns a service document into a container spec
  network-bridge/      default network provider: publishes 443/80 on the host
  network-macvlan/     dedicated-LAN-IP network provider
  proxy-caddy/         renders the reverse-proxy config
  dns-namecheap/       DNS-01 challenge record management
  cert-letsencrypt-dns01/  ACME DNS-01 cert issuance
  dns-mock/            Pebble-only test infrastructure, never trusted on a real deployment
deploy/                 Dockerfiles + docker-compose.yml
test/integration/        live-Docker acceptance suites (not mocked)
docs/                    operator guide, threat model, plugin authoring guide, design spec, build progress log
```

## Documentation

- **`docs/operator-guide.md`** -- install, first-run wizard, adding a service, network provider choice, day-to-day CLI reference.
- **`docs/threat-model.md`** -- the adversary model, what's guaranteed, what's accepted as residual risk, and every deliberate concession this project has made, documented rather than hidden.
- **`docs/plugin-authoring.md`** -- writing a third-party plugin: manifest format, capability scopes, the task/RPC contract, packaging.
- **`docs/wanfw-mvp-design-spec.md`** -- the full design spec this implementation was built from.
- **`docs/PROGRESS.md`** -- a detailed, task-by-task build log, including every real bug found during live verification and how it was fixed.

## Development

```sh
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test          # unit tests, per package
bash test/integration/run.sh                  # §12.5 isolation assertions, live Docker
bash test/integration/m1-plugin-runtime.sh    # trust/grant/timeout negative acceptance, live Docker
bash test/integration/pebble-e2e.sh           # real ACME DNS-01 flow against a local Pebble CA
```

The integration suites bring up the real compose stack, exercise it, and tear themselves down -- they need a working Docker daemon, nothing else.

## Status

MVP complete (Gate M5) -- see `docs/PROGRESS.md` for the full build history and what's been live-verified where. Post-MVP hardening (per-plugin network isolation, additional DNS/deploy providers, multi-host) is out of scope for v1 and tracked in the design spec's own residual-risk section rather than promised here.

## License

Public domain -- see `LICENSE` (Unlicense).
