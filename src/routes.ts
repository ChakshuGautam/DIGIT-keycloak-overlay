import { config } from "./config.js";

const routeMap = new Map<string, string>();

// Default DIGIT service routes — aligned with Kong kong.yml
const DEFAULT_ROUTES: Record<string, string> = {
  "/pgr-services": "pgr-services:8080",
  "/egov-workflow-v2": "egov-workflow-v2:8109",
  "/mdms-v2": "egov-mdms-service:8094",
  "/egov-hrms": "egov-hrms:8092",
  "/boundary-service": "boundary-service:8081",
  "/filestore": "egov-filestore:8083",
  "/egov-filestore": "egov-filestore:8083",
  "/egov-idgen": "egov-idgen:8088",
  "/localization": "egov-localization:8096",
  "/egov-localization": "egov-localization:8096",
  "/access": "egov-accesscontrol:8090",
  "/egov-accesscontrol": "egov-accesscontrol:8090",
  "/egov-indexer": "egov-indexer:8080",
  "/inbox": "inbox:8080",
  "/user": "egov-user:8107",
  "/egov-enc-service": "egov-enc-service:1234",
  "/egov-bndry-mgmnt": "egov-bndry-mgmnt:8080",
  "/common-persist": "egov-persister:8091",
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
