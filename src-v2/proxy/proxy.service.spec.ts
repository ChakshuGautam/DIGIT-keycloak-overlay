import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProxyService } from "./proxy.service";

// Mock routes module
vi.mock("../routes", () => ({
  initRoutes: vi.fn(),
  resolveUpstream: vi.fn((path: string) => {
    if (path.startsWith("/pgr-services"))
      return `http://pgr-services:8080${path}`;
    return null;
  }),
}));

describe("ProxyService", () => {
  let service: ProxyService;

  beforeEach(() => {
    service = new ProxyService();
  });

  it("rewrites RequestInfo in JSON body", () => {
    const body = { RequestInfo: {}, someData: "test" };
    const user = {
      uuid: "u1",
      userName: "testuser",
      name: "Test User",
      emailId: "test@example.com",
      mobileNumber: "1234567890",
      tenantId: "pg.citya",
      type: "EMPLOYEE",
      roles: [{ code: "EMPLOYEE", name: "EMPLOYEE" }],
    };

    const result = service.rewriteRequestInfo(body, user, "digit-token-123");

    expect(result.RequestInfo.authToken).toBe("digit-token-123");
    expect(result.RequestInfo.userInfo).toEqual({
      uuid: "u1",
      userName: "testuser",
      name: "Test User",
      emailId: "test@example.com",
      mobileNumber: "1234567890",
      tenantId: "pg.citya",
      type: "EMPLOYEE",
      roles: [{ code: "EMPLOYEE", name: "EMPLOYEE" }],
    });
    expect(result.someData).toBe("test");
  });

  it("builds upstream URL from route map", () => {
    const url = service.resolveUpstreamUrl("/pgr-services/v2/_search");
    expect(url).toBe("http://pgr-services:8080/pgr-services/v2/_search");
  });

  it("returns null for unknown routes", () => {
    const url = service.resolveUpstreamUrl("/unknown-service/v1/_search");
    expect(url).toBeNull();
  });

  it("creates auth query param for multipart", () => {
    const url = service.appendAuthParam(
      "http://pgr-services:8080/pgr-services/v2/_create",
      "my-token-abc",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("auth-token")).toBe("my-token-abc");
  });
});
