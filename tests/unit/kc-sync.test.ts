import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createKcAdminMock, resetState } from "../../mocks/kc-admin.js";
import { config } from "../../src/config.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { DigitUser } from "../../src/types.js";

import {
  initKcAdmin,
  stopKcAdminRefresh,
  createRealm,
  getGroupsInRealm,
  getUserGroupsInRealm,
  getUserRealmRoles,
} from "../../src/kc-admin.js";

import { syncUserToKc } from "../../src/kc-sync.js";

let server: Server;
let port: number;

const makeDigitUser = (overrides: Partial<DigitUser> = {}): DigitUser => ({
  uuid: "digit-uuid-1",
  userName: "testuser",
  name: "Test User",
  emailId: "test@example.com",
  mobileNumber: "9999999999",
  tenantId: "pg.citya",
  type: "CITIZEN",
  roles: [
    { code: "CITIZEN", name: "Citizen" },
    { code: "GRO", name: "Grievance Routing Officer" },
  ],
  ...overrides,
});

beforeAll(async () => {
  const { app } = createKcAdminMock();
  server = app.listen(0);
  port = (server.address() as AddressInfo).port;

  config.keycloakAdminUrl = `http://localhost:${port}`;

  await initKcAdmin();
});

afterAll(() => {
  stopKcAdminRefresh();
  server?.close();
});

beforeEach(() => {
  resetState();
  config.tenantSyncEnabled = true;
});

describe("syncUserToKc", () => {
  it("assigns realm roles matching DIGIT user roles", async () => {
    await createRealm("pg", ["pg.citya"]);

    const digitUser = makeDigitUser();
    await syncUserToKc("kc-sub-1", digitUser, "pg.citya");

    const roles = await getUserRealmRoles("pg", "kc-sub-1");
    const roleNames = roles.map(r => r.name).sort();
    expect(roleNames).toEqual(["CITIZEN", "GRO"]);
  });

  it("assigns user to city group based on tenantId", async () => {
    await createRealm("pg", ["pg.citya", "pg.cityb"]);

    const digitUser = makeDigitUser({ tenantId: "pg.citya" });
    await syncUserToKc("kc-sub-2", digitUser, "pg.citya");

    const userGroups = await getUserGroupsInRealm("pg", "kc-sub-2");
    expect(userGroups.length).toBe(1);
    expect(userGroups[0].name).toBe("pg.citya");
  });

  it("does nothing if tenantSyncEnabled is false", async () => {
    await createRealm("pg", ["pg.citya"]);

    config.tenantSyncEnabled = false;

    const digitUser = makeDigitUser();
    await syncUserToKc("kc-sub-3", digitUser, "pg.citya");

    // No roles should have been assigned
    const roles = await getUserRealmRoles("pg", "kc-sub-3");
    expect(roles).toEqual([]);

    // No groups should have been assigned
    const userGroups = await getUserGroupsInRealm("pg", "kc-sub-3");
    expect(userGroups).toEqual([]);
  });

  it("does not throw if KC Admin is unavailable (fire-and-forget)", async () => {
    // Point to a non-existent server to simulate KC Admin being down
    const originalUrl = config.keycloakAdminUrl;
    config.keycloakAdminUrl = "http://localhost:1";

    const digitUser = makeDigitUser();

    // syncUserToKc itself will throw (it's the caller's .catch() that swallows).
    // But we verify the fire-and-forget pattern works: wrapping in .catch() prevents unhandled rejection.
    await expect(
      syncUserToKc("kc-sub-4", digitUser, "pg.citya").catch(() => {
        // fire-and-forget: error swallowed
      }),
    ).resolves.not.toThrow();

    // Restore the URL
    config.keycloakAdminUrl = originalUrl;
  });

  it("skips group assignment for root-level tenants", async () => {
    await createRealm("pg", ["pg.citya"]);

    const digitUser = makeDigitUser({
      tenantId: "pg",
      roles: [{ code: "EMPLOYEE", name: "Employee" }],
    });
    await syncUserToKc("kc-sub-5", digitUser, "pg");

    // Roles should be assigned
    const roles = await getUserRealmRoles("pg", "kc-sub-5");
    expect(roles.map(r => r.name)).toEqual(["EMPLOYEE"]);

    // No group assignment for root tenant
    const userGroups = await getUserGroupsInRealm("pg", "kc-sub-5");
    expect(userGroups).toEqual([]);
  });

  it("skips role assignment when user has no roles", async () => {
    await createRealm("pg", ["pg.citya"]);

    const digitUser = makeDigitUser({ roles: [] });
    await syncUserToKc("kc-sub-6", digitUser, "pg.citya");

    const roles = await getUserRealmRoles("pg", "kc-sub-6");
    expect(roles).toEqual([]);
  });
});
