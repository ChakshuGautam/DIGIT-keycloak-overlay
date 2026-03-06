import { config } from "./config.js";

const routeMap = new Map<string, string>();

// Default DIGIT service routes (path prefix -> host:port)
const DEFAULT_ROUTES: Record<string, string> = {
  "/pgr-services": "pgr-services:8082",
  "/egov-workflow-v2": "egov-workflow-v2:8109",
  "/mdms-v2": "mdms-v2:8094",
  "/egov-hrms": "egov-hrms:8098",
  "/boundary-service": "boundary-service:8081",
  "/egov-filestore": "egov-filestore:8084",
  "/egov-idgen": "egov-idgen:8088",
  "/egov-localization": "egov-localization:8096",
  "/egov-accesscontrol": "egov-accesscontrol:8090",
  "/egov-indexer": "egov-indexer:8095",
  "/inbox": "inbox:8097",
  "/user": "egov-user:8107",
};

export function initRoutes() {
  // Load defaults
  for (const [path, hostPort] of Object.entries(DEFAULT_ROUTES)) {
    routeMap.set(path, `http://${hostPort}`);
  }

  // Override from env: comma-separated "/prefix=http://host:port" pairs
  if (config.upstreamServices) {
    const entries = config.upstreamServices
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const eqIdx = entry.indexOf("=");
      if (eqIdx > 0) {
        // Format: /prefix=http://host:port
        const prefix = entry.slice(0, eqIdx);
        const url = entry.slice(eqIdx + 1);
        routeMap.set(prefix, url);
      }
    }
  }
}

export function resolveUpstream(requestPath: string): string | null {
  const segments = requestPath.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const prefix = `/${segments[0]}`;
  const upstream = routeMap.get(prefix);
  if (!upstream) return null;
  return `${upstream}${requestPath}`;
}

export function getRouteMap(): Map<string, string> {
  return routeMap;
}
