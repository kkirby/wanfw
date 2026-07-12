import { randomUUID } from "node:crypto";
import type { StateStore } from "../state-store/store.js";
import type { DesiredState } from "../desired-state/index.js";
import type { ContainerSpec, MountSpec } from "../validate/index.js";
import type { NamedStage, ReconcileRunContext, StageResult } from "./types.js";
import type { PlanGraph } from "./plan-stage.js";
import type { GatedService } from "./gate-stage.js";
import type { DockerClient } from "../execute/docker-client.js";
import { ensureNetwork, ensureVolume, ensureContainer, connect, type StepResult } from "../execute/ensure.js";
import { writeProxyConfigAndReload } from "../execute/proxy.js";
import { buildProxyContainerSpec, proxyNetworksFrom, PROXY_CONTAINER_NAME, type NetworkPlanLike } from "../execute/proxy-container.js";

export interface ExecuteStageDeps {
  store: StateStore;
  docker: DockerClient;
  proxycfgDir: string;
}

function serviceNetworkName(serviceId: string): string {
  return `wanfw_svc_${serviceId}`;
}

function namedVolumes(serviceId: string, spec: ContainerSpec): MountSpec[] {
  return (spec.mounts ?? []).filter((m): m is MountSpec => m.type === "volume" && m.source.startsWith(`wanfw_${serviceId}`));
}

/**
 * EXECUTE stage (§7, T3.8): for each service whose plan is not blocked on
 * an unmet approval (GATE), runs the ordered primitive sequence -- ensure
 * network -> ensure volume(s) -> ensure container -> connect -> (proxy
 * config write + reload, once a route set exists) -- journaling every step
 * `(planId, step, result)` before moving to the next. Each `ensure*`
 * primitive is independently idempotent (ADR-9 confighash comparison), so
 * a crash mid-plan simply leaves some steps journaled and some not; the
 * next reconcile re-derives the same plan from desired state and every
 * `ensure*` call converges from wherever Docker's actual state landed --
 * no replay bookkeeping, no resume-from-step logic.
 */
export function buildExecuteStage(deps: ExecuteStageDeps): NamedStage {
  return {
    name: "execute",
    run: async (ctx: ReconcileRunContext): Promise<StageResult> => {
      const desiredState = ctx.desiredState as DesiredState | undefined;
      const planGraph = ctx.planGraph as PlanGraph | undefined;
      const gateSnapshot = ctx.gateSnapshot as Map<string, GatedService> | undefined;
      if (!desiredState?.framework || !planGraph) {
        return { ok: true };
      }

      const planId = randomUUID();
      const journal = (step: string, payload: unknown, result: StepResult | { error: string }) => {
        deps.store.appendJournal({
          plan_id: planId,
          step,
          payload_json: JSON.stringify(payload),
          result: JSON.stringify(result),
          ts: new Date().toISOString(),
        });
      };

      for (const [serviceId, rawSpec] of Object.entries(planGraph.servicePlans)) {
        const gate = gateSnapshot?.get(serviceId);
        if (gate && !gate.approved) {
          journal(`skip:${serviceId}`, {}, { step: "skip", changed: false, detail: "parked pending approval" });
          continue;
        }

        const spec = rawSpec as ContainerSpec;
        const removeVolumesOnDelete = Boolean(
          (desiredState.services.get(serviceId)?.spec.expose as { removeVolumesOnDelete?: boolean } | undefined)?.removeVolumesOnDelete,
        );
        try {
          const netResult = await ensureNetwork(deps.docker, serviceNetworkName(serviceId), { service: serviceId, plan: planId });
          journal(netResult.step, { serviceId }, netResult);

          for (const vol of namedVolumes(serviceId, spec)) {
            const volResult = await ensureVolume(deps.docker, vol.source, { service: serviceId, plan: planId, removeVolumesOnDelete });
            journal(volResult.step, { serviceId, volume: vol.source }, volResult);
          }

          const specWithPrimaryNetwork: ContainerSpec = {
            ...spec,
            networks: spec.networks && spec.networks.length > 0 ? spec.networks : [serviceNetworkName(serviceId)],
          };
          const containerName = `wanfw_${serviceId}`;
          const containerResult = await ensureContainer(deps.docker, containerName, specWithPrimaryNetwork, {
            service: serviceId,
            plan: planId,
          });
          journal(containerResult.step, { serviceId }, containerResult);

          for (const networkName of specWithPrimaryNetwork.networks ?? []) {
            const connectResult = await connect(deps.docker, containerName, networkName);
            journal(connectResult.step, { serviceId, networkName }, connectResult);
          }
        } catch (err) {
          const message = (err as Error).message;
          journal(`error:${serviceId}`, { serviceId }, { error: message });
          return { ok: false, error: { stage: "execute", plugin: serviceId, message } };
        }
      }

      // Core-emitted proxy (§8.4, ADR-9): ensure the exposure network and the
      // managed wanfw-proxy container itself exist, dual-homed onto the
      // exposure network plus every wanfw_svc_<id> network, before ever
      // attempting a config write/reload against it.
      if (planGraph.networkPlan) {
        const networkPlan = planGraph.networkPlan as NetworkPlanLike;
        const { exposureNetwork, serviceNetworks, hostPorts } = proxyNetworksFrom(
          networkPlan,
          Object.keys(planGraph.servicePlans),
        );
        if (exposureNetwork) {
          try {
            const exposureNetResult = await ensureNetwork(deps.docker, exposureNetwork, { plan: planId, core: true });
            journal(exposureNetResult.step, {}, exposureNetResult);

            const proxySpec = buildProxyContainerSpec(exposureNetwork, serviceNetworks, hostPorts);
            const proxyResult = await ensureContainer(deps.docker, PROXY_CONTAINER_NAME, proxySpec, {
              plan: planId,
              core: true,
            });
            journal(proxyResult.step, {}, proxyResult);

            for (const networkName of proxySpec.networks ?? []) {
              const connectResult = await connect(deps.docker, PROXY_CONTAINER_NAME, networkName);
              journal(connectResult.step, { networkName }, connectResult);
            }
          } catch (err) {
            const message = (err as Error).message;
            journal("error:proxy-container", {}, { error: message });
            return { ok: false, error: { stage: "execute", plugin: "proxy", message } };
          }
        }
      }

      if (planGraph.proxyRender) {
        const rendered = planGraph.proxyRender as { filename?: string; content?: string; reloadCmd?: string[] };
        if (rendered.filename && rendered.content && rendered.reloadCmd) {
          try {
            const result = await writeProxyConfigAndReload(
              deps.docker,
              deps.proxycfgDir,
              rendered.filename,
              rendered.content,
              rendered.reloadCmd,
            );
            journal("proxy.reload", { filename: rendered.filename }, { step: "proxy.reload", changed: true, detail: result.output });
          } catch (err) {
            const message = (err as Error).message;
            journal("proxy.reload", { filename: rendered.filename }, { error: message });
            return { ok: false, error: { stage: "execute", plugin: "proxy", message } };
          }
        }
      }

      ctx.executedPlanId = planId;
      return { ok: true };
    },
  };
}
