export interface RouteEntry {
  serviceId: string;
  hostname: string;
  backendPort: number;
  backendProtocol: string;
}

export interface RenderInput {
  routes: RouteEntry[];
}

export interface RenderOutput {
  filename: string;
  content: string;
  reloadCmd: string[];
}
