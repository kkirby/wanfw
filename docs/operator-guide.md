# wanfw operator guide

wanfw is a composable framework for exposing self-hosted Docker services to the WAN behind automatic TLS, without giving up control of what's actually running. This guide walks a fresh Linux host with Docker through install, first-run setup, adding a service, and day-to-day operation.

If you just want the fastest path to a working system, read sections 1-4 and stop. The rest is reference material for when you need it.

## 1. Prerequisites

- A Linux host with Docker and Docker Compose (v2, the `docker compose` subcommand) installed.
- A domain you control, with the ability to add DNS records (wanfw currently ships one DNS provider plugin: Namecheap).
- Namecheap API credentials (API user, username, API key) with the domain's zone enabled for API access. Prefer a scoped/source-IP-restricted token if Namecheap's dashboard offers one for your account tier -- see `docs/threat-model.md` R3.
- Port 443 (and 80, for ACME's HTTP-01 fallback and redirect) forwarded to this host from your router, unless you're using macvlan mode (§5).

## 2. Install

```sh
git clone <this repo> wanfw && cd wanfw
docker compose -f deploy/docker-compose.yml up -d --build
```

This builds and starts three containers: `wanfw-tier1` (the web UI, LAN port 8443), `wanfw-orchestrator` (the only container holding `/var/run/docker.sock`, `network_mode: none` otherwise), and `wanfw-pluginhost` (runs plugin code, no Docker access of any kind). See `docs/threat-model.md` for why the trust boundaries are drawn this way.

Confirm all three are up:

```sh
docker compose -f deploy/docker-compose.yml ps
```

Each container reports a Docker healthcheck once ready (tier1 and pluginhost within ~10s, orchestrator once its admin socket is listening) -- `docker compose ps` shows `healthy` once settled.

## 3. Run the setup wizard

`wanfwctl` runs *inside* the orchestrator container -- there's no separate CLI binary to install. Every invocation is `docker exec -i wanfw-orchestrator wanfwctl-inner ...`; alias it if you'll be typing it often:

```sh
alias wanfwctl='docker exec -i wanfw-orchestrator wanfwctl-inner'
```

Run the wizard:

```sh
wanfwctl init
```

It will ask for, in order:

1. **Domain** (e.g. `example.tld`) and **ACME account email**.
2. **Namecheap DNS credentials** -- stored via the secrets store, never logged, never written to the desired-state files tier1 can read:
   - **API user**: the Namecheap account enabled for API access (Namecheap: Profile > Tools > API Access).
   - **Username**: the account that owns/manages the domain -- almost always the same value as API user (only differs for reseller/sub-account setups; if unsure, enter it again).
   - **API key**.
3. **Network provider**: bridge (default -- publishes 443/80 directly on the host) or macvlan (a dedicated LAN IP for the proxy; see §5 before choosing this).
4. Nothing else -- it then batch-trusts the production plugin builtins, writes the framework document, and waits (up to 30s) for the first reconcile to bring the proxy up.

When it finishes, it prints:

```
--- Next steps ---
1. Point DNS: *.example.tld A <your WAN IP>
2. Forward WAN:443 (and :80) to this host's LAN IP.
3. Open http://<this-host-LAN-IP>:8443/setup and enter setup token: <token>
   (valid for 24h; re-run `wanfwctl init` to issue a new one)
```

Do exactly that, in order: DNS record, port-forward, then open `/setup` in a browser on the same LAN to set your tier1 admin password. These same instructions are also mirrored, read-only, on tier1's own "Setup instructions" page once you're logged in -- you don't need to keep the terminal scrollback around.

## 4. Add a service

Everything from here on happens in the tier1 web UI (`http://<host-LAN-IP>:8443`), not the CLI -- that split is deliberate (`docs/threat-model.md` G6/ADR-6): tier1 can *propose* changes, it can never *execute* anything powerful on its own.

1. Log in, go to **Services**, and add one. Give it an image, a hostname (the subdomain it'll be reachable at), and a backend port.
2. If the service needs nothing beyond an image and a port (a "baseline" deployment -- no bind mounts, no devices, no host networking, no privileged flag), it goes live within about a minute with zero further action. This is the §1.3 "second service in under a minute" bar.
3. If it needs something powerful -- a bind mount (e.g. a media library path), a device (e.g. `/dev/dri/renderD128` for hardware transcoding), host networking -- tier1 shows you the exact `wanfwctl plan approve --service <id>` command to run. It never has a button that does this itself; you paste that command into a real shell on the host.
4. Run the printed command:

```sh
wanfwctl plan approve --service jellyfin
```

If the plan touches something the framework classifies catastrophic (a Docker socket bind, `privileged`, `/dev/mem`, a raw disk device, host networking + `NET_ADMIN`) you'll see an unmissable banner ("**This grant is equivalent to root on the host**") before the approval takes effect. It's still approvable -- ADR-4's philosophy is that nothing is inexpressible -- just never silently so.

## 5. Network providers: bridge vs. macvlan

**Bridge** (default) publishes 443/80 directly on the host's own IP via standard Docker port publishing. Simplest option; works everywhere Docker itself works, including most VPS/cloud hosts where MAC-filtering would break macvlan.

**Macvlan** gives the proxy container its own dedicated IP directly on your LAN, bypassing the host's own network stack. Choose this if you want the proxy to have a stable LAN-routable address distinct from the host, or you're already running other macvlan-networked containers on the same interface. You'll need:

- The **host's LAN interface name** (run `ip route` on the host; the interface after `dev` on the default route line).
- A **reserved CIDR slice** outside your router's DHCP pool and not otherwise in use (e.g. `192.168.1.240/29` gives you 6 usable addresses) -- check your router's DHCP range first.
- Your **LAN gateway IP** (also visible in `ip route`).

Known constraint: two macvlan networks cannot share the same parent interface, subnet, *and* gateway. If you already run other macvlan infrastructure on this VLAN, either point wanfw's reserved slice at a genuinely free range within the *same* declared subnet, or use bridge mode instead. `wanfwctl doctor` (§7) will surface a real Docker daemon error here, not a silent failure, if this ever collides.

**Hairpin caveat**: in macvlan mode, the Docker host itself generally cannot reach the macvlan proxy's IP directly (a well-known Linux macvlan limitation, not a wanfw bug) -- other LAN devices can. If you need the host itself to reach your own exposed services, either use bridge mode, or set up a macvlan shim interface on the host (standard Docker macvlan documentation covers this; out of scope here since it's a host-networking change, not a wanfw one).

## 6. Removing a service

Delete the service document in tier1. The orchestrator's next reconcile garbage-collects every labeled Docker object (container, per-service network, non-retained volumes) it created for that service -- nothing lingers, and nothing outside wanfw's own labels is ever touched (ADR-9).

## 7. `wanfwctl doctor`

Run this any time something seems off, and definitely right after `init`:

```sh
wanfwctl doctor
```

It checks, independently: the Docker socket is reachable, a framework document exists, the proxy container is up, (macvlan only) a real throwaway macvlan network can actually be created on your configured parent interface, your DNS `A` record for the domain matches your detected WAN IP, and which DNS provider is bound. Each line is `[pass]`, `[FAIL]`, `[warn]`, `[info]`, or `[skip]`; the command exits non-zero (`validationFailure`, code 4) if anything hard-failed.

## 8. Secrets

```sh
wanfwctl secret list                          # names + last-rotated timestamps only, never values
echo -n 'the-value' | wanfwctl secret set dns-namecheap/api-key
wanfwctl secret unset dns-namecheap/api-key
```

Values are **only ever** accepted via stdin, never as a CLI argument -- passing one on argv is a usage error, specifically because argv is visible in shell history and `ps` output. This is enforced, not just documented.

## 9. Approvals workflow reference

```sh
wanfwctl plan list --pending                   # everything awaiting approval
wanfwctl plan show <serviceId>                 # the exact human-rendered projection, plus any banners
wanfwctl plan approve --service <id>           # approve by service id
wanfwctl plan approve --hash <projectionHash>  # or by exact projection hash
wanfwctl plan revoke <projectionHash>          # parks the plan again on the next reconcile
wanfwctl config set strictApprovals all        # route *every* plan through approval, not just powerful ones
wanfwctl config set strictApprovals powerful   # back to the default
```

An approval is bound to the exact content of a plan (its projection hash), not just a service name: an env-var-only edit keeps the same hash and stays approved; an image bump, a new bind mount, or any other powerful-field change gets a new hash and re-asks.

## 10. Certificates

```sh
wanfwctl cert list                             # stored certs, generations, metadata
wanfwctl cert rollback <name>                  # roll back to the previous generation
```

Certificate issuance is centralized in the orchestrator/cert plugin (ADR-8) -- the proxy never runs ACME itself and never holds DNS credentials or the ACME account key, only the certs it needs to serve. A cert with fewer than 7 days left before expiry surfaces as a framework-wide "degraded" alarm, unmissable in the tier1 UI.

## 11. Plugin trust

```sh
wanfwctl plugin list                           # trusted plugins
wanfwctl plugin list --pending                  # staged bundles awaiting trust
wanfwctl plugin show <id>                       # manifest + granted capabilities
wanfwctl plugin trust <id>@<sha256> --yes       # trust a staged third-party bundle
wanfwctl plugin untrust <id> --yes              # revoke trust; future plans referencing it fail validation
```

Upload a third-party plugin bundle (a `.tar` of the plugin's files) via tier1's Plugins page; it's streamed to staging and hashed, never parsed beyond that hash until you explicitly trust it. Trusting shows you the full manifest and every capability it's requesting first -- see `docs/plugin-authoring.md` for what a manifest actually declares.

## 12. Key management and audit

```sh
wanfwctl key show                              # current signing public key (PEM)
wanfwctl key rotate                             # generate a new key, re-sign all live records
wanfwctl key import < new-key.pem               # replace key custody (PKCS8 PEM via stdin, never argv)
wanfwctl audit tail                             # print the audit log
wanfwctl audit tail --verify                    # recompute the hash chain and check checkpoint signatures
```

`audit tail --verify` exits with code 6 (`refused`) and a `TAMPER DETECTED` message on the first line where the chain doesn't verify -- run it after anything that makes you suspicious of the state store's integrity.

## 13. Update story

```sh
docker compose -f deploy/docker-compose.yml pull
docker compose -f deploy/docker-compose.yml up -d
```

A straightforward `pull` + `up -d`, per spec §16. Base images are pinned by digest in the published compose file and Dockerfiles (T6.3); bumping wanfw itself means pulling new framework images, not chasing floating tags.

## 14. Uninstalling wanfw

Per ADR-9, the orchestrator creates several Docker objects directly via the Docker API rather than declaring them in the compose file: the proxy container, the exposure network, and every per-service (`wanfw_svc_<id>`) network. `docker compose down` only ever sees what's in the compose file, so it structurally cannot remove these -- run alone, it always leaves networks (and containers, if the orchestrator itself is unhealthy) behind.

Tear wanfw down completely in two steps:

```sh
wanfwctl uninstall                             # removes every wanfw.managed object compose can't see
wanfwctl uninstall --remove-volumes --yes      # also destroys wanfw-managed data volumes (irreversible)
docker compose -f deploy/docker-compose.yml down       # removes the compose-declared containers
docker compose -f deploy/docker-compose.yml down -v    # ...and add -v to also wipe compose-declared volumes (state, certs, secrets)
```

`wanfwctl uninstall` always previews the plan (every container/network it will remove, and every volume too if `--remove-volumes` is passed) and asks for confirmation before touching anything; pass `--yes` to skip the prompt for scripted use. Volumes are opt-in only (`--remove-volumes`) since they hold real service data -- an operator who just wants to redeploy cleanly, not destroy data, should omit it.

Because `wanfwctl` only ever runs via `docker exec` into the still-live orchestrator container, run `wanfwctl uninstall` *before* `docker compose down` -- once the orchestrator container itself is gone, there's nothing left to exec into. If the orchestrator is crash-looping and `docker exec` won't work, `docker compose down -v` alone will still remove the compose-managed containers and volumes; the leftover Docker-API-direct networks (and orphaned volumes, if any) then have to be cleaned up by hand with `docker network rm`/`docker volume rm` using the `wanfw.managed=true` label as a guide (`docker network ls --filter label=wanfw.managed=true`, `docker volume ls --filter label=wanfw.managed=true`).

## 15. Exit codes

| Code | Name | Meaning |
|---|---|---|
| 0 | ok | command completed successfully |
| 1 | internalError | unexpected internal error |
| 2 | usage | invalid invocation (bad flags/arguments) |
| 3 | pendingApprovalExists | a matching pending approval already exists |
| 4 | validationFailure | document or input failed validation |
| 5 | notFound | the requested object does not exist |
| 6 | refused | trust/hash mismatch, capability violation, or audit tamper detected |
| 7 | daemonUnreachable | could not reach the orchestrator admin socket |

## 16. Further reading

- `docs/threat-model.md` -- what wanfw actually protects against, what it doesn't, and why.
- `docs/plugin-authoring.md` -- writing a third-party plugin (network provider, DNS provider, cert issuer, deploy driver).
