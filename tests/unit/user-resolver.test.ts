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

  it("provisions a new DIGIT user on cache miss", async () => {
    const user = await resolveUser(baseClaims, "pg.citya");
    expect(user.emailId).toBe("alice@example.com");
    expect(user.name).toBe("Alice Smith");
    expect(user.type).toBe("CITIZEN");
    expect(user.uuid).toBeTruthy();
    // Verify it's now cached
    const cached = await getCached("kc-sub-1", "pg.citya");
    expect(cached).not.toBeNull();
    expect(cached!.user.emailId).toBe("alice@example.com");
  });

  it("returns cached user on cache hit without calling egov-user", async () => {
    const user1 = await resolveUser(baseClaims, "pg.citya");
    const user2 = await resolveUser(baseClaims, "pg.citya");
    expect(user2.uuid).toBe(user1.uuid);
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
    const user = await resolveUser(baseClaims, "pg.citya");
    expect(user.uuid).toBe("existing-uuid");
  });

  it("syncs name change from Keycloak claims to cached DIGIT user", async () => {
    await resolveUser(baseClaims, "pg.citya");
    const updatedClaims = { ...baseClaims, name: "Alice Johnson" };
    const user = await resolveUser(updatedClaims, "pg.citya");
    expect(user.name).toBe("Alice Johnson");
  });

  it("scopes users by tenant", async () => {
    const user1 = await resolveUser(baseClaims, "pg.citya");
    const user2 = await resolveUser(baseClaims, "pg.cityb");
    expect(user1.uuid).not.toBe(user2.uuid);
  });
});
