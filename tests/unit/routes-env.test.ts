import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../../src/config.js";

describe("initRoutes with UPSTREAM_SERVICES env override", () => {
  let originalUpstreamServices: string;

  beforeEach(() => {
    originalUpstreamServices = config.upstreamServices;
  });

  afterEach(() => {
    config.upstreamServices = originalUpstreamServices;
  });

  it("overrides default route with env value", async () => {
    config.upstreamServices =
      "/pgr-services=http://custom-pgr:9999,/my-svc=http://my-host:1234";

    // Re-import to get fresh initRoutes + resolveUpstream
    const { initRoutes, resolveUpstream, getRouteMap } = await import(
      "../../src/routes.js"
    );
    // Clear existing routes by re-initializing
    getRouteMap().clear();
    initRoutes();

    // Custom override applied
    expect(resolveUpstream("/pgr-services/v2/_search")).toBe(
      "http://custom-pgr:9999/pgr-services/v2/_search",
    );
    // New route added
    expect(resolveUpstream("/my-svc/api/data")).toBe(
      "http://my-host:1234/my-svc/api/data",
    );
    // Default routes still present
    expect(resolveUpstream("/mdms-v2/v1/_search")).toBe(
      "http://egov-mdms-service:8094/mdms-v2/v1/_search",
    );
  });

  it("handles empty UPSTREAM_SERVICES gracefully", async () => {
    config.upstreamServices = "";

    const { initRoutes, resolveUpstream, getRouteMap } = await import(
      "../../src/routes.js"
    );
    getRouteMap().clear();
    initRoutes();

    // Default routes still work
    expect(resolveUpstream("/pgr-services/v2/_search")).toBe(
      "http://pgr-services:8080/pgr-services/v2/_search",
    );
  });
});
