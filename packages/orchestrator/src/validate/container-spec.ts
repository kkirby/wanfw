/**
 * Full Docker create surface (ADR-4: "nothing is inexpressible"). Deploy
 * plugins emit this shape from `deploy.plan`; the orchestrator validates it
 * field by field against the emitting plugin's granted scopes (§12.1)
 * before ever calling a Docker primitive.
 */
export interface MountSpec {
  type: "volume" | "bind";
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface ContainerSpec {
  image: string;
  cmd?: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  mounts?: MountSpec[];
  devices?: string[];
  networks?: string[];
  networkMode?: "host" | string;
  ports?: number[];
  capAdd?: string[];
  privileged?: boolean;
  securityOpt?: string[];
  user?: string;
  readOnly?: boolean;
  resources?: { memory?: string; cpus?: string };
  labels?: Record<string, string>;
  restart?: string;
}
