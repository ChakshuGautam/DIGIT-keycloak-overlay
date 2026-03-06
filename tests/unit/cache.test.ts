import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initCache,
  getCached,
  setCached,
  delCached,
  closeCache,
  getRedis,
} from "../../src/cache.js";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:16379";

beforeAll(() => {
  initCache(REDIS_URL);
});

afterAll(async () => {
  await closeCache();
});

beforeEach(async () => {
  const redis = getRedis();
  const keys = await redis.keys("keycloak:test-*");
  if (keys.length) await redis.del(...keys);
});

describe("cache", () => {
  it("returns null for cache miss", async () => {
    const result = await getCached("test-nonexistent", "pg.citya");
    expect(result).toBeNull();
  });

  it("stores and retrieves a session", async () => {
    const session = {
      user: {
        uuid: "u1",
        userName: "a@b.com",
        name: "Alice",
        emailId: "a@b.com",
        mobileNumber: "9000012345",
        tenantId: "pg.citya",
        type: "CITIZEN",
        roles: [{ code: "CITIZEN", name: "Citizen" }],
      },
      cachedAt: Date.now(),
    };
    await setCached("test-sub-1", "pg.citya", session);
    const result = await getCached("test-sub-1", "pg.citya");
    expect(result).not.toBeNull();
    expect(result!.user.uuid).toBe("u1");
    expect(result!.user.emailId).toBe("a@b.com");
  });

  it("deletes a cached session", async () => {
    const session = {
      user: {
        uuid: "u2",
        userName: "b@c.com",
        name: "Bob",
        emailId: "b@c.com",
        mobileNumber: "9000012346",
        tenantId: "pg.citya",
        type: "CITIZEN",
        roles: [{ code: "CITIZEN", name: "Citizen" }],
      },
      cachedAt: Date.now(),
    };
    await setCached("test-sub-2", "pg.citya", session);
    await delCached("test-sub-2", "pg.citya");
    expect(await getCached("test-sub-2", "pg.citya")).toBeNull();
  });

  it("scopes cache by tenant", async () => {
    const session1 = {
      user: {
        uuid: "u3",
        userName: "c@d.com",
        name: "Carol",
        emailId: "c@d.com",
        mobileNumber: "9000012347",
        tenantId: "pg.citya",
        type: "CITIZEN",
        roles: [{ code: "CITIZEN", name: "Citizen" }],
      },
      cachedAt: Date.now(),
    };
    const session2 = {
      ...session1,
      user: { ...session1.user, uuid: "u4", tenantId: "pg.cityb" },
    };
    await setCached("test-sub-3", "pg.citya", session1);
    await setCached("test-sub-3", "pg.cityb", session2);
    const r1 = await getCached("test-sub-3", "pg.citya");
    const r2 = await getCached("test-sub-3", "pg.cityb");
    expect(r1!.user.uuid).toBe("u3");
    expect(r2!.user.uuid).toBe("u4");
  });
});
