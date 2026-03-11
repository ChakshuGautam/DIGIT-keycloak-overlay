import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

// Import the pure functions directly
import { rootTenant, generatePassword } from "../../src/digit-client.js";

describe("rootTenant", () => {
  it("extracts root from city-level tenant", () => {
    expect(rootTenant("pg.citya")).toBe("pg");
  });

  it("returns unchanged for root-level tenant", () => {
    expect(rootTenant("pg")).toBe("pg");
  });

  it("handles multi-segment tenant (takes first)", () => {
    expect(rootTenant("mz.sofala.beira")).toBe("mz");
  });
});

describe("createUser role merging", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let createUser: typeof import("../../src/digit-client.js").createUser;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;

    // Mock fetch for both initSystemToken and createUser
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    // Reset the module to clear cached systemToken
    vi.resetModules();
    const mod = await import("../../src/digit-client.js");
    createUser = mod.createUser;

    // First call: initSystemToken
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "mock-token" }),
    });
    await mod.initSystemToken();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("auto-adds CITIZEN role when no roles provided", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          user: [{ id: 1, userName: "test@test.com" }],
        }),
    });

    await createUser({
      name: "Test",
      email: "test@test.com",
      tenantId: "pg.citya",
      keycloakSub: "kc-sub-123",
    });

    const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(body.user.roles).toEqual([
      { code: "CITIZEN", name: "Citizen", tenantId: "pg" },
    ]);
  });

  it("adds CITIZEN role when custom roles provided without it", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          user: [{ id: 1, userName: "emp@test.com" }],
        }),
    });

    await createUser({
      name: "Employee",
      email: "emp@test.com",
      tenantId: "pg.citya",
      keycloakSub: "kc-sub-456",
      roles: [{ code: "EMPLOYEE", name: "Employee" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
    const roleCodes = body.user.roles.map((r: any) => r.code);
    expect(roleCodes).toContain("EMPLOYEE");
    expect(roleCodes).toContain("CITIZEN");
    // All roles should have tenantId set to root
    for (const role of body.user.roles) {
      expect(role.tenantId).toBe("pg");
    }
  });

  it("does not duplicate CITIZEN when already provided", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          user: [{ id: 1, userName: "cit@test.com" }],
        }),
    });

    await createUser({
      name: "Citizen",
      email: "cit@test.com",
      tenantId: "mz.chimoio",
      keycloakSub: "kc-sub-789",
      roles: [{ code: "CITIZEN", name: "Citizen" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
    const citizenCount = body.user.roles.filter(
      (r: any) => r.code === "CITIZEN",
    ).length;
    expect(citizenCount).toBe(1);
  });

  it("generates deterministic mobile number from keycloakSub", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ user: [{ id: 1, userName: "a@test.com" }] }),
    });

    await createUser({
      name: "A",
      email: "a@test.com",
      tenantId: "pg",
      keycloakSub: "fixed-sub-id",
    });

    const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
    const mobile = body.user.mobileNumber;
    expect(mobile).toMatch(/^90000\d{5}$/);

    // Verify determinism: same keycloakSub → same mobile
    const expectedHash =
      parseInt(
        createHash("sha256").update("fixed-sub-id").digest("hex").slice(0, 5),
        16,
      ) % 100000;
    expect(mobile).toBe(`90000${String(expectedHash).padStart(5, "0")}`);
  });

  it("uses provided phoneNumber instead of generated one", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ user: [{ id: 1, userName: "b@test.com" }] }),
    });

    await createUser({
      name: "B",
      email: "b@test.com",
      tenantId: "pg",
      keycloakSub: "sub-with-phone",
      phoneNumber: "9876543210",
    });

    const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(body.user.mobileNumber).toBe("9876543210");
  });

  it("generates password matching DIGIT policy format", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ user: [{ id: 1, userName: "c@test.com" }] }),
    });

    await createUser({
      name: "C",
      email: "c@test.com",
      tenantId: "pg",
      keycloakSub: "pw-test-sub",
    });

    const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
    const pw = body.user.password;
    // Format: Kc<6-hex-chars>@1
    expect(pw).toMatch(/^Kc[0-9a-f]{6}@1$/);
    // Must have uppercase, lowercase, digit, special
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[@#$%]/);
  });

  it("throws on createUser failure", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await expect(
      createUser({
        name: "Fail",
        email: "fail@test.com",
        tenantId: "pg",
        keycloakSub: "fail-sub",
      }),
    ).rejects.toThrow("User creation failed: 500");
  });
});

describe("getUserToken", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let getUserToken: typeof import("../../src/digit-client.js").getUserToken;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    vi.resetModules();
    const mod = await import("../../src/digit-client.js");
    getUserToken = mod.getUserToken;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns token and expiresIn from citizen login", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "citizen-token-abc",
          token_type: "bearer",
          expires_in: 604800,
        }),
    });

    const result = await getUserToken("alice@test.com", "Kcabc123@1", "pg.citya");
    expect(result.token).toBe("citizen-token-abc");
    expect(result.expiresIn).toBe(604800 * 1000); // converted to ms

    // Verify it sent correct params
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain("/user/oauth/token");
    const body = opts.body;
    expect(body).toContain("userType=CITIZEN");
    expect(body).toContain("username=alice%40test.com");
    expect(body).toContain("tenantId=pg"); // root tenant
  });

  it("throws on citizen login failure", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    await expect(
      getUserToken("bad@test.com", "wrong", "pg"),
    ).rejects.toThrow("Citizen login failed: 401");
  });
});

describe("generatePassword", () => {
  it("generates deterministic password matching DIGIT policy", () => {
    const pw = generatePassword("test-seed");
    expect(pw).toMatch(/^Kc[0-9a-f]{6}@1$/);
    // Same seed = same password
    expect(generatePassword("test-seed")).toBe(pw);
  });

  it("generates different passwords for different seeds", () => {
    expect(generatePassword("seed-a")).not.toBe(generatePassword("seed-b"));
  });
});
