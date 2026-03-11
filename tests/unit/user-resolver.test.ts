import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initCache, closeCache, getRedis, getCached } from "../../src/cache.js";
import { config } from "../../src/config.js";
import { initSystemToken } from "../../src/digit-client.js";
import { resolveUser } from "../../src/user-resolver.js";
import { createEgovUserMock } from "../../mocks/egov-user.js";
import type { KCClaims } from "../../src/types.js";
import type { AddressInfo } from "node:net";

let egovServer: any;
let egovMock: ReturnType<typeof createEgovUserMock>;

beforeAll(async () => {
  // Start mock egov-user on random port
  egovMock = createEgovUserMock();
  egovServer = egovMock.app.listen(0);
  const port = (egovServer.address() as AddressInfo).port;

  // Point config at mock
  (config as any).digitUserHost = `http://localhost:${port}`;

  // Init Redis + system token
  initCache("redis://localhost:16379");
  await initSystemToken();
});

afterAll(async () => {
  egovServer?.close();
  await closeCache();
});

beforeEach(async () => {
  // Clear cache and mock user store
  const redis = getRedis();
  const keys = await redis.keys("keycloak:*");
  if (keys.length) await redis.del(...keys);
  egovMock.users.clear();
});

describe("resolveUser", () => {
  const baseClaims: KCClaims = {
    sub: "kc-sub-1",
    email: "alice@example.com",
    name: "Alice Smith",
  };

  it("provisions a new DIGIT user on cache miss and returns citizen token", async () => {
    const { user, token } = await resolveUser(baseClaims, "pg.citya");
    expect(user.emailId).toBe("alice@example.com");
    expect(user.name).toBe("Alice Smith");
    expect(user.type).toBe("CITIZEN");
    expect(user.uuid).toBeTruthy();
    expect(token).toBeTruthy();
    expect(token).toMatch(/^token-for-/);
    // Verify it's now cached with token
    const cached = await getCached("kc-sub-1", "pg.citya");
    expect(cached).not.toBeNull();
    expect(cached!.user.emailId).toBe("alice@example.com");
    expect(cached!.token).toBeTruthy();
    expect(cached!.tokenExpiry).toBeGreaterThan(Date.now());
  });

  it("returns cached user and token on cache hit without calling egov-user", async () => {
    const { user: user1 } = await resolveUser(baseClaims, "pg.citya");
    const { user: user2, token: token2 } = await resolveUser(baseClaims, "pg.citya");
    expect(user2.uuid).toBe(user1.uuid);
    expect(token2).toBeTruthy();
  });

  it("finds existing DIGIT user by email instead of creating new", async () => {
    egovMock.users.set("existing-uuid", {
      uuid: "existing-uuid",
      userName: "alice@example.com",
      name: "Alice Old",
      emailId: "alice@example.com",
      mobileNumber: "9000012345",
      tenantId: "pg.citya",
      type: "CITIZEN",
      roles: [{ code: "CITIZEN", name: "Citizen" }],
      password: "x",
    });
    const { user } = await resolveUser(baseClaims, "pg.citya");
    expect(user.uuid).toBe("existing-uuid");
  });

  it("syncs name change from Keycloak claims to cached DIGIT user", async () => {
    await resolveUser(baseClaims, "pg.citya");
    const updatedClaims = { ...baseClaims, name: "Alice Johnson" };
    const { user } = await resolveUser(updatedClaims, "pg.citya");
    expect(user.name).toBe("Alice Johnson");
  });

  it("same root tenant shares DIGIT user, but caches per city tenant", async () => {
    // DIGIT stores users at root tenant (pg), not city tenant (pg.citya)
    // So pg.citya and pg.cityb resolve to the same DIGIT user
    const { user: user1 } = await resolveUser(baseClaims, "pg.citya");
    const { user: user2 } = await resolveUser(baseClaims, "pg.cityb");
    expect(user1.uuid).toBe(user2.uuid);
    // But cache entries are separate per city tenant
    const cached1 = await getCached("kc-sub-1", "pg.citya");
    const cached2 = await getCached("kc-sub-1", "pg.cityb");
    expect(cached1).not.toBeNull();
    expect(cached2).not.toBeNull();
  });

  it("different root tenants create separate DIGIT users", async () => {
    const { user: user1 } = await resolveUser(baseClaims, "pg.citya");
    const { user: user2 } = await resolveUser(baseClaims, "statea.cityb");
    expect(user1.uuid).not.toBe(user2.uuid);
  });

  it("provisions user with DIGIT roles from KC realm_access", async () => {
    const claims: KCClaims = {
      sub: "kc-roles-1",
      email: "employee@example.com",
      name: "Employee User",
      realm_access: { roles: ["EMPLOYEE", "GRO", "default-roles-digit-sandbox"] },
    };
    const { user } = await resolveUser(claims, "pg.citya");
    const roleCodes = user.roles.map(r => r.code);
    expect(roleCodes).toContain("EMPLOYEE");
    expect(roleCodes).toContain("GRO");
    expect(roleCodes).toContain("CITIZEN");
    expect(roleCodes).not.toContain("default-roles-digit-sandbox");
  });

  it("provisions user with only CITIZEN when no realm_access", async () => {
    const claims: KCClaims = { sub: "kc-noroles-1", email: "plain@example.com" };
    const { user } = await resolveUser(claims, "pg.citya");
    expect(user.roles.map(r => r.code)).toEqual(["CITIZEN"]);
  });

  it("syncs roles on subsequent login when KC roles change", async () => {
    const claims1: KCClaims = {
      sub: "kc-rolesync-1", email: "sync@example.com", name: "Sync",
    };
    const { user: user1 } = await resolveUser(claims1, "pg.citya");
    expect(user1.roles.map(r => r.code)).toEqual(["CITIZEN"]);

    const claims2: KCClaims = {
      ...claims1,
      realm_access: { roles: ["SUPERUSER", "EMPLOYEE"] },
    };
    const { user: user2 } = await resolveUser(claims2, "pg.citya");
    const roleCodes = user2.roles.map(r => r.code);
    expect(roleCodes).toContain("SUPERUSER");
    expect(roleCodes).toContain("EMPLOYEE");
    expect(roleCodes).toContain("CITIZEN");
  });
});
