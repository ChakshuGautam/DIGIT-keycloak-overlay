import "reflect-metadata";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { KcAdminService } from "./kc-admin.service";

describe("KcAdminService", () => {
  let service: KcAdminService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  const mockConfigService = {
    get: (key: string) => {
      const map: Record<string, string> = {
        KEYCLOAK_ADMIN_URL: "http://localhost:8080",
        KEYCLOAK_ADMIN_REALM: "master",
        KEYCLOAK_ADMIN_CLIENT_ID: "admin-cli",
        KEYCLOAK_ADMIN_USERNAME: "admin",
        KEYCLOAK_ADMIN_PASSWORD: "admin",
        TENANT_SYNC_ENABLED: "false",
        DIGIT_TENANTS: "pg:pg.citya,pg.cityb;mz:mz.maputo",
      };
      return map[key];
    },
  };

  const mockMetricsService = {
    tokenRefreshTotal: { inc: vi.fn() },
    roleSyncTotal: { inc: vi.fn() },
  };

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    service = new KcAdminService(mockConfigService as any, mockMetricsService as any);
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.unstubAllGlobals();
  });

  it("retries on init failure then succeeds", async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: "test-token" }),
      });

    await service.initWithRetry(5, 10);

    expect(service.hasAdminToken()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("gives up after max retries", async () => {
    fetchSpy.mockRejectedValue(new Error("connection refused"));

    await service.initWithRetry(3, 10);

    expect(service.hasAdminToken()).toBe(false);
  });

  it("reports token status as false on new instance", () => {
    expect(service.hasAdminToken()).toBe(false);
  });

  it("parses tenant config", () => {
    const result = service.parseTenantConfig("pg:pg.citya,pg.cityb;mz:mz.maputo");
    expect(result.get("pg")).toEqual(["pg.citya", "pg.cityb"]);
    expect(result.get("mz")).toEqual(["mz.maputo"]);
  });
});
