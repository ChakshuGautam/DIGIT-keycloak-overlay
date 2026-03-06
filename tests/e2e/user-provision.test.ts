import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestApp, stopTestApp, getAppPort, clearCache } from "./test-app.js";
import { getCached } from "../../src/cache.js";
import { signJwt } from "../helpers.js";

beforeAll(async () => {
  await startTestApp();
});

afterAll(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearCache();
});

describe("E2E: user provisioning", () => {
  it("creates a new DIGIT user on first request", async () => {
    const token = await signJwt({
      sub: "new-user-1",
      email: "new@test.com",
      name: "New User",
    });

    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
      },
    );
    expect(resp.status).toBe(200);

    // Verify user is cached
    const cached = await getCached("new-user-1", "pg.citya");
    expect(cached).not.toBeNull();
    expect(cached!.user.emailId).toBe("new@test.com");
    expect(cached!.user.name).toBe("New User");
    expect(cached!.user.mobileNumber).toMatch(/^90000\d{5}$/);
  });

  it("generates unique mobile numbers per user", async () => {
    const token1 = await signJwt({
      sub: "mobile-1",
      email: "m1@test.com",
      name: "M1",
    });
    const token2 = await signJwt({
      sub: "mobile-2",
      email: "m2@test.com",
      name: "M2",
    });

    const opts = (token: string) => ({
      method: "POST" as const,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
    });

    await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      opts(token1),
    );
    await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      opts(token2),
    );

    const c1 = await getCached("mobile-1", "pg.citya");
    const c2 = await getCached("mobile-2", "pg.citya");
    expect(c1!.user.mobileNumber).not.toBe(c2!.user.mobileNumber);
  });

  it("provisions user with roles from JWT realm_access", async () => {
    const token = await signJwt({
      sub: "role-user-1",
      email: "roles@test.com",
      name: "Role User",
      realm_access: { roles: ["GRO", "EMPLOYEE"] },
    });
    await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
      },
    );
    const cached = await getCached("role-user-1", "pg.citya");
    const codes = cached!.user.roles.map((r: any) => r.code);
    expect(codes).toContain("GRO");
    expect(codes).toContain("EMPLOYEE");
    expect(codes).toContain("CITIZEN");
  });
});
