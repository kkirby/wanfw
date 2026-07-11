export type CapabilityTier = "baseline" | "powerful";

export interface CapabilityDef {
  id: string;
  tier: CapabilityTier;
  /** Human-readable description of the scope shape, for docs/manifest authors. */
  scopeShape: string;
}

/**
 * Full capability taxonomy: spec §12.1 (ContainerSpec field -> capability
 * mapping) union with §6.6 (host API methods) and the network-provider /
 * DNS / cert capabilities referenced throughout §6 and the ADRs.
 */
export const CAPABILITIES = {
  "docker.image.pull": { id: "docker.image.pull", tier: "baseline", scopeShape: "{ repos: string[] } (glob)" },
  "docker.volume.named": { id: "docker.volume.named", tier: "baseline", scopeShape: "{} (own wanfw_ prefix implied)" },
  "docker.mount.bind": { id: "docker.mount.bind", tier: "powerful", scopeShape: "{ paths: string[] } (glob, ro/rw)" },
  "docker.device": { id: "docker.device", tier: "powerful", scopeShape: "{ paths: string[] } (glob, must match /dev/*)" },
  "docker.network.host": { id: "docker.network.host", tier: "powerful", scopeShape: "{}" },
  "docker.privileged": { id: "docker.privileged", tier: "powerful", scopeShape: "{}" },
  "docker.capabilities": { id: "docker.capabilities", tier: "powerful", scopeShape: "{ caps: string[] }" },
  "docker.ports.publish": { id: "docker.ports.publish", tier: "powerful", scopeShape: "{ ports: number[] } (list/range)" },
  "docker.network.attach": { id: "docker.network.attach", tier: "baseline", scopeShape: "{} (own service network / plan-created only)" },
  "docker.network.provision": { id: "docker.network.provision", tier: "powerful", scopeShape: "{ mode: string, parent?: string }" },
  "docker.exec": { id: "docker.exec", tier: "powerful", scopeShape: "{ targets: string[] } (managed container name glob)" },
  "state.rw": { id: "state.rw", tier: "baseline", scopeShape: "{} (own plugin namespace)" },
  "log.emit": { id: "log.emit", tier: "baseline", scopeShape: "{}" },
  "secrets.read": { id: "secrets.read", tier: "powerful", scopeShape: "{ names: string[] } (glob; own prefix is the norm)" },
  "secrets.write": { id: "secrets.write", tier: "powerful", scopeShape: "{ names: string[] } (glob; own prefix is the norm)" },
  "dns.record.write": { id: "dns.record.write", tier: "powerful", scopeShape: "{ zones: string[] }" },
  "dns.query": { id: "dns.query", tier: "baseline", scopeShape: "{}" },
  "certs.store": { id: "certs.store", tier: "powerful", scopeShape: "{}" },
  "net.egress": { id: "net.egress", tier: "baseline", scopeShape: "{ endpoints: string[] } (enforcement: declared only, v1)" },
} as const satisfies Record<string, CapabilityDef>;

export type CapabilityId = keyof typeof CAPABILITIES;

export function isPowerful(capId: CapabilityId): boolean {
  return CAPABILITIES[capId].tier === "powerful";
}

export const ALL_CAPABILITY_IDS = Object.keys(CAPABILITIES) as CapabilityId[];
