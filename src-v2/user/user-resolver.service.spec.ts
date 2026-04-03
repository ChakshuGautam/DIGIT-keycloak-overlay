import "reflect-metadata";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { UserResolverService } from "./user-resolver.service";
import type { CacheService } from "../cache/cache.service";
import type { MetricsService } from "../metrics/metrics.service";
import { rootTenant } from "../routes";
import type { JwtClaims, DigitUser, CachedSession } from "../types";

const claims: JwtClaims = {
  sub: "kc-sub-1",
  email: "alice@example.com",
  name: "Alice",
  realm: "pg",
  roles: ["CITIZEN", "GRO"],
};

const digitUser: DigitUser = {
  uuid: "digit-uuid-1",
  userName: "pg:alice@example.com",
  name: "Alice",
  emailId: "alice@example.com",
  mobileNumber: "9000012345",
  tenantId: "pg",
  type: "CITIZEN",
  roles: [{ code: "CITIZEN", name: "Citizen" }],
};

describe("UserResolverService", () => {
  let service: UserResolverService;

  const mockCache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    isStale: vi.fn().mockReturnValue(false),
  };

  const mockDigit = {
    namespacedUserName: vi.fn((r: string, e: string) => `${r}:${e}`),
    searchUser: vi.fn().mockResolvedValue(null),
    createUser: vi.fn().mockResolvedValue(digitUser),
    generateRandomPassword: vi.fn().mockReturnValue("KcRandom123@1"),
    getUserToken: vi.fn().mockResolvedValue({ token: "digit-token", expiresIn: 86400000 }),
    updateUserPassword: vi.fn().mockResolvedValue(undefined),
    updateUserRoles: vi.fn().mockResolvedValue(undefined),
    resolveUserType: vi.fn().mockReturnValue("CITIZEN"),
    generateV1Password: vi.fn().mockReturnValue("Kcabcdef@1"),
    getSystemPassword: vi.fn().mockReturnValue("eGov@123"),
  };

  const mockMetrics = {
    cacheOpsTotal: { inc: vi.fn() },
    userProvisionTotal: { inc: vi.fn() },
    roleSyncTotal: { inc: vi.fn() },
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset defaults
    mockCache.get.mockResolvedValue(null);
    mockCache.isStale.mockReturnValue(false);
    mockDigit.searchUser.mockResolvedValue(null);
    mockDigit.createUser.mockResolvedValue(digitUser);
    mockDigit.getUserToken.mockResolvedValue({ token: "digit-token", expiresIn: 86400000 });
    mockDigit.resolveUserType.mockReturnValue("CITIZEN");

    service = new UserResolverService(
      mockCache as unknown as CacheService,
      mockDigit as any,
      mockMetrics as unknown as MetricsService,
    );
  });

  it("returns cached user on cache hit", async () => {
    const cachedUser: DigitUser = {
      ...digitUser,
      roles: [{ code: "CITIZEN", name: "CITIZEN" }, { code: "GRO", name: "GRO" }],
    };
    const cached: CachedSession = {
      user: cachedUser,
      password: "KcRandom123@1",
      cachedAt: Date.now(),
      token: "digit-token",
      tokenExpiry: Date.now() + 86400000,
    };
    mockCache.get.mockResolvedValue(cached);

    const result = await service.resolve(claims, "pg.citya");

    expect(result.user).toEqual(cachedUser);
    expect(result.token).toBe("digit-token");
    expect(mockDigit.searchUser).not.toHaveBeenCalled();
    expect(mockDigit.createUser).not.toHaveBeenCalled();
  });

  it("provisions new user on cache miss", async () => {
    mockCache.get.mockResolvedValue(null);
    mockDigit.searchUser.mockResolvedValue(null);

    const result = await service.resolve(claims, "pg.citya");

    expect(mockDigit.createUser).toHaveBeenCalled();
    expect(mockDigit.getUserToken).toHaveBeenCalled();
    expect(result.user).toEqual(digitUser);
    expect(result.token).toBe("digit-token");
    expect(mockCache.set).toHaveBeenCalled();
  });

  it("finds existing user and gets token on cache miss", async () => {
    mockCache.get.mockResolvedValue(null);
    mockDigit.searchUser.mockResolvedValue(digitUser);

    const result = await service.resolve(claims, "pg.citya");

    expect(mockDigit.createUser).not.toHaveBeenCalled();
    expect(mockDigit.getUserToken).toHaveBeenCalled();
    expect(result.token).toBe("digit-token");
    expect(mockCache.set).toHaveBeenCalled();
  });

  it("uses realm-namespaced userName for search", async () => {
    mockCache.get.mockResolvedValue(null);

    await service.resolve(claims, "pg.citya");

    expect(mockDigit.namespacedUserName).toHaveBeenCalledWith("pg", "alice@example.com");
    expect(mockDigit.searchUser).toHaveBeenCalledWith("pg:alice@example.com", "pg");
  });

  it("syncs roles when JWT roles differ from cached", async () => {
    const cached: CachedSession = {
      user: { ...digitUser, roles: [{ code: "CITIZEN", name: "Citizen" }] },
      password: "KcRandom123@1",
      cachedAt: Date.now(),
      token: "digit-token",
      tokenExpiry: Date.now() + 86400000,
    };
    mockCache.get.mockResolvedValue(cached);

    // claims has roles: ["CITIZEN", "GRO"] but cached only has CITIZEN
    const result = await service.resolve(claims, "pg.citya");

    expect(mockDigit.updateUserRoles).toHaveBeenCalled();
    expect(mockCache.set).toHaveBeenCalled();
  });

  it("refreshes expired token on cache hit", async () => {
    const cached: CachedSession = {
      user: digitUser,
      password: "KcRandom123@1",
      cachedAt: Date.now(),
      token: "old-token",
      tokenExpiry: Date.now() - 1000, // expired
    };
    mockCache.get.mockResolvedValue(cached);

    const result = await service.resolve(claims, "pg.citya");

    expect(mockDigit.getUserToken).toHaveBeenCalledWith(
      "pg:alice@example.com",
      "KcRandom123@1",
      "pg",
      "CITIZEN",
    );
    expect(result.token).toBe("digit-token");
  });

  it("re-validates stale sessions", async () => {
    const cached: CachedSession = {
      user: { ...digitUser, active: true },
      password: "KcRandom123@1",
      cachedAt: Date.now(),
      token: "digit-token",
      tokenExpiry: Date.now() + 86400000,
    };
    mockCache.get.mockResolvedValue(cached);
    mockCache.isStale.mockReturnValue(true);
    mockDigit.searchUser.mockResolvedValue({ ...digitUser, active: true });

    const result = await service.resolve(claims, "pg.citya");

    expect(mockDigit.searchUser).toHaveBeenCalledWith("pg:alice@example.com", "pg");
    expect(result.user).toBeDefined();
  });

  it("evicts deactivated user on staleness check", async () => {
    const cached: CachedSession = {
      user: { ...digitUser, active: true },
      password: "KcRandom123@1",
      cachedAt: Date.now(),
      token: "digit-token",
      tokenExpiry: Date.now() + 86400000,
    };
    mockCache.get.mockResolvedValue(cached);
    mockCache.isStale.mockReturnValue(true);
    mockDigit.searchUser.mockResolvedValue({ ...digitUser, active: false });

    await expect(service.resolve(claims, "pg.citya")).rejects.toThrow("User deactivated");
    expect(mockCache.delete).toHaveBeenCalledWith("kc-sub-1", "pg.citya");
  });

  it("uses correct userType from claims", async () => {
    mockCache.get.mockResolvedValue(null);
    mockDigit.resolveUserType.mockReturnValue("EMPLOYEE");

    const employeeClaims = { ...claims, roles: ["EMPLOYEE", "GRO"] };
    const employeeUser = { ...digitUser, type: "EMPLOYEE" };
    mockDigit.createUser.mockResolvedValue(employeeUser);

    await service.resolve(employeeClaims, "pg.citya");

    expect(mockDigit.resolveUserType).toHaveBeenCalledWith(employeeClaims.roles);
    expect(mockDigit.getUserToken).toHaveBeenCalledWith(
      "pg:alice@example.com",
      "KcRandom123@1",
      "pg",
      "EMPLOYEE",
    );
  });

  it("syncs name change from JWT claims", async () => {
    const cached: CachedSession = {
      user: { ...digitUser, name: "Alice Old" },
      password: "KcRandom123@1",
      cachedAt: Date.now(),
      token: "digit-token",
      tokenExpiry: Date.now() + 86400000,
    };
    mockCache.get.mockResolvedValue(cached);

    const updatedClaims = { ...claims, name: "Alice New" };
    const result = await service.resolve(updatedClaims, "pg.citya");

    expect(result.user.name).toBe("Alice New");
  });

  it("provisions user with only CITIZEN when no roles in JWT", async () => {
    mockCache.get.mockResolvedValue(null);
    mockDigit.searchUser.mockResolvedValue(null);

    const noRoleClaims: JwtClaims = {
      sub: "kc-noroles-1",
      email: "plain@example.com",
      realm: "pg",
      roles: [],
    };

    const citizenUser = {
      ...digitUser,
      uuid: "digit-noroles-1",
      emailId: "plain@example.com",
      roles: [{ code: "CITIZEN", name: "Citizen" }],
    };
    mockDigit.createUser.mockResolvedValue(citizenUser);

    const result = await service.resolve(noRoleClaims, "pg.citya");

    expect(result.user.roles).toEqual([
      { code: "CITIZEN", name: "Citizen" },
    ]);
    expect(mockDigit.createUser).toHaveBeenCalled();
  });

  it("falls back to v1 password when random password fails", async () => {
    mockCache.get.mockResolvedValue(null);
    mockDigit.searchUser.mockResolvedValue(null);

    // First getUserToken (random pw) fails, second (v1 pw) succeeds
    mockDigit.getUserToken
      .mockRejectedValueOnce(new Error("401"))
      .mockResolvedValueOnce({ token: "v1-token", expiresIn: 86400000 });

    const result = await service.resolve(claims, "pg.citya");

    expect(result.token).toBe("v1-token");
    expect(mockDigit.getUserToken).toHaveBeenCalledTimes(2);
    expect(mockDigit.generateV1Password).toHaveBeenCalledWith("kc-sub-1");
  });

  it("falls back to system password when v1 password also fails", async () => {
    mockCache.get.mockResolvedValue(null);
    mockDigit.searchUser.mockResolvedValue(null);

    // All three attempts: random fails, v1 fails, system default succeeds
    mockDigit.getUserToken
      .mockRejectedValueOnce(new Error("401"))
      .mockRejectedValueOnce(new Error("401"))
      .mockResolvedValueOnce({ token: "sys-token", expiresIn: 86400000 });

    const result = await service.resolve(claims, "pg.citya");

    expect(result.token).toBe("sys-token");
    expect(mockDigit.getUserToken).toHaveBeenCalledTimes(3);
    expect(mockDigit.getSystemPassword).toHaveBeenCalled();
  });
});
