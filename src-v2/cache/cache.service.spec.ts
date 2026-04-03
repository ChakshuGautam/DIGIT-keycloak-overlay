import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CacheService } from "./cache.service";
import type { CachedSession } from "../types";

// Mock ioredis
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  scanStream: vi.fn(),
  ping: vi.fn(),
  on: vi.fn(),
  disconnect: vi.fn(),
  quit: vi.fn(),
};

vi.mock("ioredis", () => ({
  default: vi.fn(() => mockRedis),
}));

const mockConfigService = {
  get: vi.fn((key: string) => {
    const config: Record<string, string | number> = {
      REDIS_HOST: "localhost",
      REDIS_PORT: 6379,
      CACHE_PREFIX: "keycloak",
      CACHE_TTL_SECONDS: 3600,
    };
    return config[key];
  }),
};

function makeCachedSession(overrides: Partial<CachedSession> = {}): CachedSession {
  return {
    user: {
      uuid: "user-1",
      userName: "testuser",
      name: "Test User",
      emailId: "test@example.com",
      mobileNumber: "9999999999",
      tenantId: "pg.citya",
      type: "EMPLOYEE",
      roles: [{ code: "EMPLOYEE", name: "Employee" }],
    },
    password: "hashed-pw",
    cachedAt: Date.now(),
    ...overrides,
  };
}

describe("CacheService", () => {
  let service: CacheService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.ping.mockResolvedValue("PONG");
    service = new CacheService(mockConfigService as any);
    // Simulate healthy redis
    (service as any).redisHealthy = true;
  });

  afterEach(() => {
    // Clean up timers
    if ((service as any).healthCheckInterval) {
      clearInterval((service as any).healthCheckInterval);
    }
  });

  it("returns cached session on hit", async () => {
    const session = makeCachedSession();
    mockRedis.get.mockResolvedValue(JSON.stringify(session));

    const result = await service.get("sub-1", "pg.citya");

    expect(result).toEqual(session);
    expect(mockRedis.get).toHaveBeenCalledWith("keycloak:sub-1:pg.citya");
  });

  it("returns null on cache miss", async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await service.get("sub-missing", "pg.citya");

    expect(result).toBeNull();
  });

  it("writes to both redis and memory", async () => {
    const session = makeCachedSession();
    mockRedis.set.mockResolvedValue("OK");

    await service.set("sub-1", "pg.citya", session);

    expect(mockRedis.set).toHaveBeenCalledWith(
      "keycloak:sub-1:pg.citya",
      JSON.stringify(session),
      "EX",
      3600,
    );

    // Also check memory fallback has it
    mockRedis.get.mockRejectedValue(new Error("redis down"));
    (service as any).redisHealthy = false;

    const result = await service.get("sub-1", "pg.citya");
    expect(result).toEqual(session);
  });

  it("falls back to memory when redis fails", async () => {
    const session = makeCachedSession();

    // Prime the memory cache
    (service as any).memoryCache.set("keycloak:sub-1:pg.citya", session);
    (service as any).redisHealthy = false;

    const result = await service.get("sub-1", "pg.citya");

    expect(result).toEqual(session);
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it("deletes from both redis and memory", async () => {
    const session = makeCachedSession();
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.del.mockResolvedValue(1);

    // Set first
    await service.set("sub-1", "pg.citya", session);

    // Delete
    await service.delete("sub-1", "pg.citya");

    expect(mockRedis.del).toHaveBeenCalledWith("keycloak:sub-1:pg.citya");

    // Memory should also be cleared
    (service as any).redisHealthy = false;
    const result = await service.get("sub-1", "pg.citya");
    expect(result).toBeNull();
  });

  it("deletes all tenants for a sub", async () => {
    const keys = ["keycloak:sub-1:pg.citya", "keycloak:sub-1:pg.cityb"];

    // Mock scanStream to return an EventEmitter-like object
    const mockStream = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === "data") {
          // Emit keys in the next tick
          setTimeout(() => handler(keys), 0);
        }
        if (event === "end") {
          setTimeout(() => handler(), 10);
        }
        return mockStream;
      }),
    };
    mockRedis.scanStream.mockReturnValue(mockStream);
    mockRedis.del.mockResolvedValue(2);

    // Also prime memory cache
    const session = makeCachedSession();
    (service as any).memoryCache.set("keycloak:sub-1:pg.citya", session);
    (service as any).memoryCache.set("keycloak:sub-1:pg.cityb", session);

    const count = await service.deleteAllForSub("sub-1");

    expect(count).toBe(2);
    expect(mockRedis.scanStream).toHaveBeenCalledWith({
      match: "keycloak:sub-1:*",
      count: 100,
    });
  });

  it("detects stale sessions", () => {
    const staleSession = makeCachedSession({
      cachedAt: Date.now() - 7200 * 1000, // 2 hours ago
    });

    expect(service.isStale(staleSession)).toBe(true);
    expect(service.isStale(staleSession, 3600)).toBe(true);
  });

  it("detects fresh sessions", () => {
    const freshSession = makeCachedSession({
      cachedAt: Date.now() - 60 * 1000, // 1 minute ago
    });

    expect(service.isStale(freshSession)).toBe(false);
    expect(service.isStale(freshSession, 3600)).toBe(false);
  });
});
