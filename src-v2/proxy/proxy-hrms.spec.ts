import "reflect-metadata";
import { describe, it, expect } from "vitest";

/**
 * Tests for the HRMS URL-rewriting logic in proxy.controller.ts handleAll().
 *
 * The controller rewrites URLs for /egov-hrms/ and /boundary-service/ endpoints
 * that contain _search or _count — adding default offset/limit and tenantId
 * when missing. We extract and test that logic here with plain URL manipulation
 * (same algorithm the controller uses).
 */

/** Replicates the URL-rewriting logic from ProxyController.handleAll */
function rewriteHrmsUrl(
  requestUrl: string,
  body: Record<string, any> = {},
  defaultTenant = "pg.citya",
): string {
  if (
    (requestUrl.includes("/egov-hrms/") ||
      requestUrl.includes("/boundary-service/")) &&
    (requestUrl.includes("_search") || requestUrl.includes("_count"))
  ) {
    const url = new URL(requestUrl, "http://localhost");
    if (!url.searchParams.has("offset")) url.searchParams.set("offset", "0");
    if (!url.searchParams.has("limit")) url.searchParams.set("limit", "100");
    if (!url.searchParams.has("tenantId")) {
      const tenantId =
        body.criteria?.tenantId || body.tenantId || defaultTenant;
      url.searchParams.set("tenantId", tenantId);
    }
    return url.pathname + url.search;
  }
  return requestUrl;
}

describe("HRMS URL rewriting", () => {
  // ── offset/limit injection ──────────────────────────────────────────────

  it("adds offset=0&limit=100 to HRMS _search URL when missing", () => {
    const result = rewriteHrmsUrl("/egov-hrms/employees/_search");
    expect(result).toContain("offset=0");
    expect(result).toContain("limit=100");
  });

  it("adds offset=0&limit=100 to HRMS _count URL when missing", () => {
    const result = rewriteHrmsUrl("/egov-hrms/employees/_count");
    expect(result).toContain("offset=0");
    expect(result).toContain("limit=100");
  });

  it("adds offset=0&limit=100 to boundary-service _search URL when missing", () => {
    const result = rewriteHrmsUrl(
      "/boundary-service/boundary/_search?hierarchyType=ADMIN",
    );
    expect(result).toContain("offset=0");
    expect(result).toContain("limit=100");
    // Preserves existing params
    expect(result).toContain("hierarchyType=ADMIN");
  });

  it("does NOT overwrite existing offset/limit", () => {
    const result = rewriteHrmsUrl(
      "/egov-hrms/employees/_search?offset=10&limit=50",
    );
    expect(result).toContain("offset=10");
    expect(result).toContain("limit=50");
    expect(result).not.toContain("offset=0");
    expect(result).not.toContain("limit=100");
  });

  it("does NOT overwrite existing offset when only offset is present", () => {
    const result = rewriteHrmsUrl("/egov-hrms/employees/_search?offset=5");
    expect(result).toContain("offset=5");
    // limit was missing, so it gets added
    expect(result).toContain("limit=100");
  });

  // ── tenantId injection ──────────────────────────────────────────────────

  it("extracts tenantId from body.criteria when missing in URL", () => {
    const result = rewriteHrmsUrl("/egov-hrms/employees/_count", {
      criteria: { tenantId: "pg.cityb" },
    });
    expect(result).toContain("tenantId=pg.cityb");
  });

  it("extracts tenantId from body.tenantId when criteria absent", () => {
    const result = rewriteHrmsUrl("/egov-hrms/employees/_count", {
      tenantId: "pg.cityc",
    });
    expect(result).toContain("tenantId=pg.cityc");
  });

  it("uses default tenant when body has no tenantId", () => {
    const result = rewriteHrmsUrl("/egov-hrms/employees/_count", {});
    expect(result).toContain("tenantId=pg.citya");
  });

  it("does NOT overwrite existing tenantId in URL", () => {
    const result = rewriteHrmsUrl(
      "/egov-hrms/employees/_search?tenantId=pg.existing",
      { criteria: { tenantId: "pg.fromBody" } },
    );
    expect(result).toContain("tenantId=pg.existing");
    expect(result).not.toContain("tenantId=pg.fromBody");
  });

  // ── non-HRMS URLs are untouched ────────────────────────────────────────

  it("does NOT modify non-HRMS URLs", () => {
    const original = "/pgr-services/v2/_search?tenantId=pg.citya";
    const result = rewriteHrmsUrl(original);
    expect(result).toBe(original);
  });

  it("does NOT modify HRMS URLs without _search or _count", () => {
    const original = "/egov-hrms/employees/_create";
    const result = rewriteHrmsUrl(original);
    expect(result).toBe(original);
  });

  it("does NOT modify user service URLs", () => {
    const original = "/user/_search";
    const result = rewriteHrmsUrl(original);
    expect(result).toBe(original);
  });
});
