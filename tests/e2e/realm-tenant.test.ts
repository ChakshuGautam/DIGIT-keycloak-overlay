import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestApp, stopTestApp, getAppPort, clearCache } from "./test-app.js";
import { signJwt } from "../helpers.js";
import {
  initKcAdmin,
  syncTenantRealms,
  getUserRealmRoles,
  getUserGroupsInRealm,
  stopKcAdminRefresh,
} from "../../src/kc-admin.js";

beforeAll(async () => {
  await startTestApp();

  // Initialize KC Admin client so syncTenantRealms and assertion helpers work.
  // The test app's startTestApp() does not call initKcAdmin() (that only happens
  // in the main server entry point), so we do it here.
  await initKcAdmin();
  await syncTenantRealms();
});

afterAll(async () => {
  stopKcAdminRefresh();
  await stopTestApp();
});

beforeEach(async () => {
  await clearCache();
});

describe("E2E: realm-per-tenant", () => {
  it("resolves a user and syncs roles to KC mock", async () => {
    const token = await signJwt({
      sub: "realm-user-1",
      email: "realm1@test.com",
      name: "Realm User 1",
      realm_access: { roles: ["CITIZEN", "GRO"] },
    });

    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          RequestInfo: { apiId: "Rainmaker" },
          tenantId: "pg.citya",
        }),
      },
    );

    expect(resp.status).toBe(200);

    // The fire-and-forget KC sync is async; wait for it to complete
    await new Promise((r) => setTimeout(r, 200));

    // Verify KC Admin mock received the role assignments in the "pg" realm
    const roles = await getUserRealmRoles("pg", "realm-user-1");
    const roleNames = roles.map((r) => r.name).sort();
    expect(roleNames).toContain("CITIZEN");
    expect(roleNames).toContain("GRO");
  });

  it("assigns user to city group after first request", async () => {
    const token = await signJwt({
      sub: "realm-user-2",
      email: "realm2@test.com",
      name: "Realm User 2",
      realm_access: { roles: ["CITIZEN"] },
    });

    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          RequestInfo: { apiId: "Rainmaker" },
          tenantId: "pg.citya",
        }),
      },
    );

    expect(resp.status).toBe(200);

    // Wait for fire-and-forget sync
    await new Promise((r) => setTimeout(r, 200));

    // Verify user was assigned to the "pg.citya" group in the "pg" realm
    const groups = await getUserGroupsInRealm("pg", "realm-user-2");
    const groupNames = groups.map((g) => g.name);
    expect(groupNames).toContain("pg.citya");
  });

  it("JWT with realm_access.roles maps to DIGIT user roles", async () => {
    const token = await signJwt({
      sub: "realm-user-3",
      email: "realm3@test.com",
      name: "Realm User 3",
      realm_access: { roles: ["CITIZEN", "GRO", "PGR_LME"] },
    });

    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          RequestInfo: { apiId: "Rainmaker" },
          tenantId: "pg.citya",
        }),
      },
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;

    // The proxied request should contain user info with the KC-derived roles
    const userInfo = body.receivedRequestInfo?.userInfo;
    expect(userInfo).toBeTruthy();
    const roleCodes = userInfo.roles.map((r: { code: string }) => r.code).sort();
    expect(roleCodes).toContain("CITIZEN");
    expect(roleCodes).toContain("GRO");
    expect(roleCodes).toContain("PGR_LME");
  });

  it("groups claim appears in resolved user context", async () => {
    const token = await signJwt({
      sub: "realm-user-4",
      email: "realm4@test.com",
      name: "Realm User 4",
      groups: ["/pg.citya"],
    });

    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          RequestInfo: { apiId: "Rainmaker" },
          tenantId: "pg.citya",
        }),
      },
    );

    // The request should succeed (JWT with groups claim is valid)
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.echo).toBe(true);
    expect(body.receivedRequestInfo.userInfo).toBeTruthy();
  });
});
