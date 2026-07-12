export interface RouteEntry {
  serviceId: string;
  hostname: string;
  backendPort: number;
  backendProtocol: string;
}

export interface CertPaths {
  certPath: string;
  keyPath: string;
}

export interface RenderInput {
  routes: RouteEntry[];
  /** Stored cert/key paths from wanfw_certs (T4.5), or undefined if none has been issued yet -- falls back to `tls internal`. */
  cert?: CertPaths;
}

export interface RenderOutput {
  filename: string;
  content: string;
  reloadCmd: string[];
}
