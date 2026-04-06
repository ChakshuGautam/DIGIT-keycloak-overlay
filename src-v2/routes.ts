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
  // egov-user-event is not in Kong's declarative config — route direct to container
  "/egov-user-event": "http://egov-user-event:8080",
  "/common-persist": "egov-persister:8091",
};

let routeMap: Map<string, string>;

export function initRoutes(overrides?: string): Map<string, string> {
  routeMap = new Map(Object.entries(DEFAULT_ROUTES));
  if (overrides) {
    for (const entry of overrides.split(",")) {
      const [path, host] = entry.split("=");
      if (path && host) routeMap.set(path.trim(), host.trim());
    }
  }
  return routeMap;
}

export function resolveUpstream(requestPath: string): string | null {
  if (!routeMap) initRoutes();
  const segments = requestPath.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const prefix = `/${segments[0]}`;
  const upstream = routeMap.get(prefix);
  if (!upstream) return null;
  const proto = upstream.startsWith("http") ? "" : "http://";
  return `${proto}${upstream}${requestPath}`;
}

export function rootTenant(tenantId: string): string {
  return tenantId.split(".")[0];
}
