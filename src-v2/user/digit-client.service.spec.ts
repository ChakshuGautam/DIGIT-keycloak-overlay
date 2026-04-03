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
});
