import { describe, it, expect, beforeAll } from "vitest";
import { initRoutes, resolveUpstream } from "../../src/routes.js";

beforeAll(() => {
  initRoutes();
});

describe("resolveUpstream", () => {
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
});
