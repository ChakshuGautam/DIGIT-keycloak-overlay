import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createKcAdminMock, resetState } from "../../mocks/kc-admin.js";
import { config } from "../../src/config.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  initKcAdmin,
  stopKcAdminRefresh,
  createRealm,
  listRealms,
  createGroupInRealm,
  getGroupsInRealm,
  addUserToGroupInRealm,
  getUserGroupsInRealm,
  assignRealmRoles,
  getUserRealmRoles,
  syncTenantRealms,
  _parseTenantEnv,
} from "../../src/kc-admin.js";

let server: Server;
let port: number;

beforeAll(async () => {
  const { app } = createKcAdminMock();
  server = app.listen(0);
  port = (server.address() as AddressInfo).port;

  // Override config directly since it's resolved at import time
  config.keycloakAdminUrl = `http://localhost:${port}`;

  await initKcAdmin();
});

afterAll(() => {
  stopKcAdminRefresh();
  server?.close();
});

beforeEach(() => {
  resetState();
});

describe("initKcAdmin", () => {
  it("authenticates against mock KC Admin", async () => {
    // initKcAdmin was already called in beforeAll without throwing.
    // Verify we can make authenticated requests by listing realms.
    const realms = await listRealms();
    expect(Array.isArray(realms)).toBe(true);
  });
});

describe("realm operations", () => {
  it("creates a realm from template", async () => {
    await createRealm("pg", ["pg.citya", "pg.cityb"]);
    const realms = await listRealms();
    expect(realms).toContain("pg");
  });

  it("handles duplicate realm creation (409)", async () => {
    await createRealm("pg", ["pg.citya"]);
    // Second call should not throw — it handles 409 gracefully
    await expect(createRealm("pg", ["pg.citya", "pg.cityb"])).resolves.not.toThrow();
    // The new group should have been added
    const groups = await getGroupsInRealm("pg");
    const names = groups.map((g) => g.name);
    expect(names).toContain("pg.citya");
    expect(names).toContain("pg.cityb");
  });

  it("lists existing realms", async () => {
    await createRealm("pg", ["pg.citya"]);
    await createRealm("mz", ["mz.chimoio"]);
    const realms = await listRealms();
    expect(realms).toContain("pg");
    expect(realms).toContain("mz");
    expect(realms.length).toBe(2);
  });
});

describe("group operations", () => {
  it("creates a group within a realm", async () => {
    await createRealm("pg", []);
    const id = await createGroupInRealm("pg", "pg.citya");
    expect(id).toBeTruthy();

    const groups = await getGroupsInRealm("pg");
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe("pg.citya");
    expect(groups[0].path).toBe("/pg.citya");
  });

  it("handles duplicate group (409)", async () => {
    await createRealm("pg", ["pg.citya"]);
    // Creating the same group again should not throw — returns existing ID
    const id = await createGroupInRealm("pg", "pg.citya");
    expect(id).toBeTruthy();
    // Still only one group
    const groups = await getGroupsInRealm("pg");
    expect(groups.length).toBe(1);
  });

  it("lists groups in a realm", async () => {
    await createRealm("pg", ["pg.citya", "pg.cityb"]);
    const groups = await getGroupsInRealm("pg");
    expect(groups.length).toBe(2);
    const names = groups.map((g) => g.name).sort();
    expect(names).toEqual(["pg.citya", "pg.cityb"]);
  });
});

describe("user-group operations", () => {
  it("assigns a user to a group", async () => {
    await createRealm("pg", ["pg.citya"]);
    const groups = await getGroupsInRealm("pg");
    const groupId = groups[0].id;
    const userId = "user-uuid-1";

    await addUserToGroupInRealm("pg", userId, groupId);
    const userGroups = await getUserGroupsInRealm("pg", userId);
    expect(userGroups.length).toBe(1);
    expect(userGroups[0].name).toBe("pg.citya");
  });

  it("returns user groups", async () => {
    await createRealm("pg", ["pg.citya", "pg.cityb"]);
    const groups = await getGroupsInRealm("pg");
    const userId = "user-uuid-2";

    for (const g of groups) {
      await addUserToGroupInRealm("pg", userId, g.id);
    }
    const userGroups = await getUserGroupsInRealm("pg", userId);
    expect(userGroups.length).toBe(2);
    const names = userGroups.map((g) => g.name).sort();
    expect(names).toEqual(["pg.citya", "pg.cityb"]);
  });

  it("returns empty for user with no groups", async () => {
    await createRealm("pg", ["pg.citya"]);
    const userGroups = await getUserGroupsInRealm("pg", "no-such-user");
    expect(userGroups).toEqual([]);
  });
});

describe("user-role operations", () => {
  it("assigns realm roles to a user", async () => {
    await createRealm("pg", []);
    const userId = "user-uuid-3";
    // The realm template includes CITIZEN, EMPLOYEE, GRO roles
    await assignRealmRoles("pg", userId, ["CITIZEN", "GRO"]);

    const roles = await getUserRealmRoles("pg", userId);
    expect(roles.length).toBe(2);
    const names = roles.map((r) => r.name).sort();
    expect(names).toEqual(["CITIZEN", "GRO"]);
  });

  it("returns user realm roles", async () => {
    await createRealm("pg", []);
    const userId = "user-uuid-4";
    await assignRealmRoles("pg", userId, ["EMPLOYEE", "SUPERUSER"]);

    const roles = await getUserRealmRoles("pg", userId);
    expect(roles.length).toBe(2);
    const names = roles.map((r) => r.name).sort();
    expect(names).toEqual(["EMPLOYEE", "SUPERUSER"]);
  });
});

describe("syncTenantRealms", () => {
  it("creates realms and groups from DIGIT_TENANTS env var", async () => {
    config.digitTenants = "pg:pg.citya,pg.cityb;mz:mz.chimoio";
    await syncTenantRealms();

    const realms = await listRealms();
    expect(realms).toContain("pg");
    expect(realms).toContain("mz");

    const pgGroups = await getGroupsInRealm("pg");
    expect(pgGroups.map((g) => g.name).sort()).toEqual(["pg.citya", "pg.cityb"]);

    const mzGroups = await getGroupsInRealm("mz");
    expect(mzGroups.map((g) => g.name)).toEqual(["mz.chimoio"]);

    config.digitTenants = "";
  });

  it("is idempotent", async () => {
    config.digitTenants = "pg:pg.citya";
    await syncTenantRealms();
    // Second call should not throw
    await expect(syncTenantRealms()).resolves.not.toThrow();

    const realms = await listRealms();
    expect(realms.filter((r) => r === "pg").length).toBe(1);

    const groups = await getGroupsInRealm("pg");
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe("pg.citya");

    config.digitTenants = "";
  });
});

describe("parseTenantEnv", () => {
  it("parses structured format", () => {
    const result = _parseTenantEnv("pg:pg.citya,pg.cityb;mz:mz.chimoio");
    expect(result.size).toBe(2);
    expect(result.get("pg")).toEqual(["pg.citya", "pg.cityb"]);
    expect(result.get("mz")).toEqual(["mz.chimoio"]);
  });

  it("parses flat list", () => {
    const result = _parseTenantEnv("pg.citya,pg.cityb,mz.chimoio");
    expect(result.size).toBe(2);
    expect(result.get("pg")).toEqual(["pg.citya", "pg.cityb"]);
    expect(result.get("mz")).toEqual(["mz.chimoio"]);
  });

  it("returns empty for empty string", () => {
    expect(_parseTenantEnv("").size).toBe(0);
    expect(_parseTenantEnv("  ").size).toBe(0);
  });
});
