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

  it("parses tenant config (structured format)", () => {
    const result = service.parseTenantConfig("pg:pg.citya,pg.cityb;mz:mz.maputo");
    expect(result.get("pg")).toEqual(["pg.citya", "pg.cityb"]);
    expect(result.get("mz")).toEqual(["mz.maputo"]);
  });

  it("parses tenant config (flat list format)", () => {
    const result = service.parseTenantConfig("pg.citya,pg.cityb,mz.chimoio");
    expect(result.size).toBe(2);
    expect(result.get("pg")).toEqual(["pg.citya", "pg.cityb"]);
    expect(result.get("mz")).toEqual(["mz.chimoio"]);
  });

  it("returns empty map for empty tenant string", () => {
    expect(service.parseTenantConfig("").size).toBe(0);
    expect(service.parseTenantConfig("  ").size).toBe(0);
  });

  it("creates realm via fetch POST", async () => {
    // Acquire token first
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "test-token" }),
    });
    await service.initWithRetry(1, 10);

    // Mock realm creation (201 success)
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 201,
    });

    await service.createRealm("pg", ["pg.citya"]);

    // The second fetch call (index 1) should be the realm creation
    const [url, opts] = fetchSpy.mock.calls[1];
    expect(url).toBe("http://localhost:8080/admin/realms");
    expect(opts.method).toBe("POST");
  });

  it("handles duplicate realm creation (409) gracefully", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "test-token" }),
    });
    await service.initWithRetry(1, 10);

    // Mock 409 on realm creation, then GET groups returns existing groups
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: () => Promise.resolve("Conflict"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ id: "g1", name: "pg.citya", path: "/pg.citya" }]),
      });

    await expect(service.createRealm("pg", ["pg.citya"])).resolves.not.toThrow();
  });

  it("lists realms", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "test-token" }),
    });
    await service.initWithRetry(1, 10);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { realm: "master" },
          { realm: "pg" },
        ]),
    });

    const realms = await service.listRealms();
    expect(realms).toContain("master");
    expect(realms).toContain("pg");
  });

  it("assigns realm roles to user", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "test-token" }),
    });
    await service.initWithRetry(1, 10);

    // Mock role lookup for CITIZEN
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "role-1", name: "CITIZEN" }),
    });
    // Mock role assignment POST
    fetchSpy.mockResolvedValueOnce({ ok: true });

    await expect(
      service.assignRealmRoles("pg", "user-1", ["CITIZEN"]),
    ).resolves.not.toThrow();
  });

  it("gets user realm roles", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "test-token" }),
    });
    await service.initWithRetry(1, 10);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { name: "CITIZEN" },
          { name: "GRO" },
        ]),
    });

    const roles = await service.getUserRealmRoles("pg", "user-1");
    expect(roles.map((r) => r.name).sort()).toEqual(["CITIZEN", "GRO"]);
  });

  it("creates group in realm", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "test-token" }),
    });
    await service.initWithRetry(1, 10);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 201,
      headers: new Map([["Location", "/admin/realms/pg/groups/g-new-1"]]),
    });

    const id = await service.createGroupInRealm("pg", "pg.citya");
    expect(id).toBeTruthy();
  });

  it("adds user to group in realm", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "test-token" }),
    });
    await service.initWithRetry(1, 10);

    fetchSpy.mockResolvedValueOnce({ ok: true });

    await expect(
      service.addUserToGroupInRealm("pg", "user-1", "group-1"),
    ).resolves.not.toThrow();
  });

  it("gets user groups in realm", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "test-token" }),
    });
    await service.initWithRetry(1, 10);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: "g1", name: "pg.citya", path: "/pg.citya" },
        ]),
    });

    const groups = await service.getUserGroupsInRealm("pg", "user-1");
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe("pg.citya");
  });
});
