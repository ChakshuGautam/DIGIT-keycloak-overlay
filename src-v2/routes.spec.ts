import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { initRoutes, resolveUpstream, rootTenant } from "./routes";

describe("resolveUpstream", () => {
  beforeEach(() => {
    initRoutes();
  });

  it("maps /pgr-services path to upstream", () => {
    const url = resolveUpstream("/pgr-services/v2/_search");
    expect(url).toBe("http://pgr-services:8080/pgr-services/v2/_search");
  });

  it("maps /mdms-v2 path to upstream", () => {
    const url = resolveUpstream("/mdms-v2/v1/_search");
    expect(url).toBe("http://egov-mdms-service:8094/mdms-v2/v1/_search");
  });

  it("returns null for unknown path", () => {
    expect(resolveUpstream("/unknown-service/foo")).toBeNull();
  });

  it("returns null for empty path", () => {
    expect(resolveUpstream("/")).toBeNull();
  });

  it("maps /user path to egov-user upstream", () => {
    const url = resolveUpstream("/user/_search");
    expect(url).toBe("http://egov-user:8107/user/_search");
  });

  it("maps /inbox path to upstream", () => {
    const url = resolveUpstream("/inbox/v2/_search");
    expect(url).toBe("http://inbox:8080/inbox/v2/_search");
  });
});

describe("resolveUpstream with overrides", () => {
  it("overrides default route with env value", () => {
    initRoutes("/pgr-services=http://custom-pgr:9999,/my-svc=http://my-host:1234");

    expect(resolveUpstream("/pgr-services/v2/_search")).toBe(
      "http://custom-pgr:9999/pgr-services/v2/_search",
    );
    expect(resolveUpstream("/my-svc/api/data")).toBe(
      "http://my-host:1234/my-svc/api/data",
    );
    // Default routes still present
    expect(resolveUpstream("/mdms-v2/v1/_search")).toBe(
      "http://egov-mdms-service:8094/mdms-v2/v1/_search",
    );
  });

  it("handles empty overrides gracefully", () => {
    initRoutes("");

    expect(resolveUpstream("/pgr-services/v2/_search")).toBe(
      "http://pgr-services:8080/pgr-services/v2/_search",
    );
  });
});

describe("rootTenant", () => {
  it("extracts root from city-level tenant", () => {
    expect(rootTenant("pg.citya")).toBe("pg");
  });

  it("returns unchanged for root-level tenant", () => {
    expect(rootTenant("pg")).toBe("pg");
  });

  it("handles multi-segment tenant (takes first)", () => {
    expect(rootTenant("mz.sofala.beira")).toBe("mz");
  });
});
