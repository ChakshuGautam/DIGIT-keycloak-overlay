import "reflect-metadata";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { DigitClientService } from "./digit-client.service";
import { ConfigService } from "@nestjs/config";

const configMap: Record<string, string> = {
  DIGIT_USER_HOST: "http://localhost:8107",
  DIGIT_SYSTEM_USERNAME: "ADMIN",
  DIGIT_SYSTEM_PASSWORD: "eGov@123",
  DIGIT_SYSTEM_USER_TYPE: "EMPLOYEE",
  DIGIT_SYSTEM_TENANT: "pg",
  DIGIT_DEFAULT_TENANT: "pg.citya",
};

describe("DigitClientService", () => {
  let service: DigitClientService;
  let circuitBreaker: { exec: ReturnType<typeof vi.fn> };
  let metrics: {
    tokenRefreshTotal: { inc: ReturnType<typeof vi.fn> };
    userProvisionTotal: { inc: ReturnType<typeof vi.fn> };
  };
  let mockConfigService: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.restoreAllMocks();

    mockConfigService = {
      get: vi.fn((key: string) => configMap[key]),
    };

    circuitBreaker = {
      exec: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
    };

    metrics = {
      tokenRefreshTotal: { inc: vi.fn() },
      userProvisionTotal: { inc: vi.fn() },
    };

    // Mock fetch for system token acquisition in onModuleInit
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "sys-token-123",
        expires_in: 86400,
      }),
    });

    service = new DigitClientService(
      mockConfigService as unknown as ConfigService,
      circuitBreaker as any,
      metrics as any,
    );
  });

  it("generates random passwords meeting DIGIT policy", () => {
    const passwords = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const pw = service.generateRandomPassword();
      passwords.add(pw);
      expect(pw.length).toBeGreaterThanOrEqual(8);
      expect(pw.length).toBeLessThanOrEqual(15);
      // Must contain uppercase, lowercase, digit, and special char
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^A-Za-z0-9]/);
    }
    // All 100 should be unique
    expect(passwords.size).toBe(100);
  });

  it("generates mobile numbers in 90000XXXXX format", () => {
    const mobile = service.generateMobileNumber("some-user-sub");
    expect(mobile).toMatch(/^90000\d{5}$/);
  });

  it("generates different mobiles for different subs", () => {
    const m1 = service.generateMobileNumber("user-sub-aaa");
    const m2 = service.generateMobileNumber("user-sub-bbb");
    expect(m1).not.toBe(m2);
  });

  it("uses circuit breaker for egov-user calls", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        user: [{ uuid: "u1", userName: "test", name: "Test", emailId: "a@b.com", mobileNumber: "9000012345", tenantId: "pg.citya", type: "CITIZEN", roles: [] }],
      }),
    });

    await service.searchUser("a@b.com", "pg.citya");
    expect(circuitBreaker.exec).toHaveBeenCalledWith("egov-user", expect.any(Function));
  });

  it("respects user type from claims", () => {
    expect(service.resolveUserType("EMPLOYEE")).toBe("EMPLOYEE");
    expect(service.resolveUserType(undefined)).toBe("CITIZEN");
    expect(service.resolveUserType("CITIZEN")).toBe("CITIZEN");
    expect(service.resolveUserType("something-else")).toBe("CITIZEN");
  });

  it("namespaces userName with realm", () => {
    expect(service.namespacedUserName("pg", "alice@example.com")).toBe(
      "pg:alice@example.com",
    );
  });

  it("generates deterministic mobile number from sub", () => {
    const m1 = service.generateMobileNumber("fixed-sub-id");
    const m2 = service.generateMobileNumber("fixed-sub-id");
    expect(m1).toBe(m2);
  });

  it("generates v1-compatible deterministic password", () => {
    const pw = service.generateV1Password("test-seed");
    expect(pw).toMatch(/^Kc[0-9a-f]{6}@1$/);
    // Same seed = same password
    expect(service.generateV1Password("test-seed")).toBe(pw);
  });

  it("generates different v1 passwords for different seeds", () => {
    expect(service.generateV1Password("seed-a")).not.toBe(
      service.generateV1Password("seed-b"),
    );
  });

  it("creates user via postToDigit", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        user: [
          {
            uuid: "new-u1",
            userName: "pg:test@test.com",
            name: "Test",
            emailId: "test@test.com",
            mobileNumber: "9000012345",
            tenantId: "pg",
            type: "CITIZEN",
            roles: [{ code: "CITIZEN", name: "Citizen", tenantId: "pg" }],
          },
        ],
      }),
    });

    const user = await service.createUser({
      userName: "pg:test@test.com",
      name: "Test",
      email: "test@test.com",
      mobileNumber: "9000012345",
      tenantId: "pg",
      password: "KcRandom123@1",
      type: "CITIZEN",
    });

    expect(user.uuid).toBe("new-u1");
    expect(user.emailId).toBe("test@test.com");
    expect(circuitBreaker.exec).toHaveBeenCalledWith(
      "egov-user",
      expect.any(Function),
    );
  });

  it("throws on createUser failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(
      service.createUser({
        userName: "pg:fail@test.com",
        name: "Fail",
        email: "fail@test.com",
        mobileNumber: "9000000000",
        tenantId: "pg",
        password: "KcRandom123@1",
        type: "CITIZEN",
      }),
    ).rejects.toThrow("500");
  });

  it("getUserToken returns token and expiresIn", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "citizen-token-abc",
        expires_in: 604800,
      }),
    });

    const result = await service.getUserToken(
      "alice@test.com",
      "Kcabc123@1",
      "pg",
      "CITIZEN",
    );
    expect(result.token).toBe("citizen-token-abc");
    expect(result.expiresIn).toBe(604800);
  });

  it("throws on getUserToken failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    await expect(
      service.getUserToken("bad@test.com", "wrong", "pg", "CITIZEN"),
    ).rejects.toThrow("401");
  });

  // ── v1 gap: role merging on createUser ────────────────────────────────────

  it("auto-adds CITIZEN role when no roles provided to createUser", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        user: [
          {
            uuid: "u-role-1",
            userName: "pg:role@test.com",
            name: "Role Test",
            emailId: "role@test.com",
            mobileNumber: "9000012345",
            tenantId: "pg",
            type: "CITIZEN",
            roles: [{ code: "CITIZEN", name: "Citizen", tenantId: "pg" }],
          },
        ],
      }),
    });

    await service.createUser({
      userName: "pg:role@test.com",
      name: "Role Test",
      email: "role@test.com",
      mobileNumber: "9000012345",
      tenantId: "pg",
      password: "KcRandom123@1",
      type: "CITIZEN",
      // no roles provided
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.user.roles).toEqual([
      { code: "CITIZEN", name: "Citizen", tenantId: "pg" },
    ]);
  });

  it("uses provided roles when passed to createUser", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        user: [
          {
            uuid: "u-role-2",
            userName: "pg:emp@test.com",
            name: "Employee",
            emailId: "emp@test.com",
            mobileNumber: "9000012345",
            tenantId: "pg",
            type: "EMPLOYEE",
            roles: [
              { code: "EMPLOYEE", name: "Employee", tenantId: "pg" },
              { code: "CITIZEN", name: "Citizen", tenantId: "pg" },
            ],
          },
        ],
      }),
    });

    await service.createUser({
      userName: "pg:emp@test.com",
      name: "Employee",
      email: "emp@test.com",
      mobileNumber: "9000012345",
      tenantId: "pg",
      password: "KcRandom123@1",
      type: "EMPLOYEE",
      roles: [
        { code: "EMPLOYEE", name: "Employee", tenantId: "pg" },
        { code: "CITIZEN", name: "Citizen", tenantId: "pg" },
      ],
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const roleCodes = body.user.roles.map((r: any) => r.code);
    expect(roleCodes).toContain("EMPLOYEE");
    expect(roleCodes).toContain("CITIZEN");
  });

  it("updateUserRoles auto-adds CITIZEN when not provided", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: [{ uuid: "u1" }] }),
    });

    await service.updateUserRoles("u1", "pg", [
      { code: "GRO", name: "GRO" },
    ]);

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const roleCodes = body.user.roles.map((r: any) => r.code);
    expect(roleCodes).toContain("GRO");
    expect(roleCodes).toContain("CITIZEN");
  });

  // ── HRMS fix: null userName guard in createUser ─────────────────────────

  it("rejects createUser when userName is null", async () => {
    await expect(
      service.createUser({
        userName: null as unknown as string,
        name: "Bad",
        email: "bad@test.com",
        tenantId: "pg",
        password: "KcRandom123@1",
        type: "CITIZEN",
      }),
    ).rejects.toThrow("userName is null or empty");
  });

  it("rejects createUser when userName is empty string", async () => {
    await expect(
      service.createUser({
        userName: "",
        name: "Bad",
        email: "bad@test.com",
        tenantId: "pg",
        password: "KcRandom123@1",
        type: "CITIZEN",
      }),
    ).rejects.toThrow("userName is null or empty");
  });

  it('rejects createUser when userName is literal "null"', async () => {
    await expect(
      service.createUser({
        userName: "null",
        name: "Bad",
        email: "bad@test.com",
        tenantId: "pg",
        password: "KcRandom123@1",
        type: "CITIZEN",
      }),
    ).rejects.toThrow("userName is null or empty");
  });

  it("rejects createUser when userName is whitespace-only", async () => {
    await expect(
      service.createUser({
        userName: "   ",
        name: "Bad",
        email: "bad@test.com",
        tenantId: "pg",
        password: "KcRandom123@1",
        type: "CITIZEN",
      }),
    ).rejects.toThrow("userName is null or empty");
  });

  it("does not call fetch when userName is invalid", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    await service
      .createUser({
        userName: "null",
        name: "Bad",
        email: "bad@test.com",
        tenantId: "pg",
        password: "KcRandom123@1",
        type: "CITIZEN",
      })
      .catch(() => {});

    // fetch should NOT have been called — guard rejects before any HTTP
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("updateUserRoles does not duplicate CITIZEN when already provided", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: [{ uuid: "u1" }] }),
    });

    await service.updateUserRoles("u1", "pg", [
      { code: "CITIZEN", name: "Citizen" },
      { code: "GRO", name: "GRO" },
    ]);

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const citizenCount = body.user.roles.filter(
      (r: any) => r.code === "CITIZEN",
    ).length;
    expect(citizenCount).toBe(1);
  });
});
