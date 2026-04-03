import "reflect-metadata";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { LoginController } from "./login.controller";
import { HttpException } from "@nestjs/common";

describe("LoginController", () => {
  let controller: LoginController;
  let mockJwtService: { validate: ReturnType<typeof vi.fn> };
  let mockUserResolver: { resolve: ReturnType<typeof vi.fn> };
  let mockCacheService: { deleteAllForSub: ReturnType<typeof vi.fn> };
  let mockConfigService: { get: ReturnType<typeof vi.fn> };

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockJwtService = {
      validate: vi.fn(),
    };
    mockUserResolver = {
      resolve: vi.fn(),
    };
    mockCacheService = {
      deleteAllForSub: vi.fn(),
    };
    mockConfigService = {
      get: vi.fn((key: string) => {
        const config: Record<string, string> = {
          KEYCLOAK_INTERNAL_URL: "http://keycloak:8080",
          KEYCLOAK_REALM: "digit",
          KEYCLOAK_BFF_CLIENT_ID: "bff-client",
          KEYCLOAK_BFF_CLIENT_SECRET: "bff-secret",
          KEYCLOAK_ADMIN_URL: "http://keycloak:8080",
          KEYCLOAK_ADMIN_CLIENT_ID: "admin-cli",
          KEYCLOAK_ADMIN_CLIENT_SECRET: "admin-secret",
          DIGIT_DEFAULT_TENANT: "pg.citya",
        };
        return config[key];
      }),
    };

    controller = new LoginController(
      mockJwtService as any,
      mockUserResolver as any,
      mockCacheService as any,
      mockConfigService as any,
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects missing credentials (400)", async () => {
    await expect(controller.login({ email: "", password: "" })).rejects.toThrow(
      HttpException,
    );

    try {
      await controller.login({ email: "", password: "" });
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(400);
    }
  });

  it("does not return refresh_token in response", async () => {
    // Mock KC token response
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "access-jwt",
          id_token: "id-jwt",
          refresh_token: "refresh-jwt-secret",
          expires_in: 300,
        }),
    }) as any;

    // Mock JWT validation returning claims
    mockJwtService.validate.mockResolvedValue({
      sub: "user-sub-1",
      email: "test@example.com",
      name: "Test User",
      realm: "digit",
      roles: ["EMPLOYEE"],
    });

    // Mock user resolver
    mockUserResolver.resolve.mockResolvedValue({
      user: {
        uuid: "u1",
        userName: "testuser",
        name: "Test User",
        emailId: "test@example.com",
        mobileNumber: "1234567890",
        tenantId: "pg.citya",
        type: "EMPLOYEE",
        roles: [{ code: "EMPLOYEE", name: "EMPLOYEE" }],
      },
      token: "digit-token",
    });

    const result = await controller.login({
      email: "test@example.com",
      password: "password123",
    });

    expect(result).not.toHaveProperty("refresh_token");
    expect(result).toHaveProperty("access_token", "access-jwt");
    expect(result).toHaveProperty("digit_user_name");
    expect(result).toHaveProperty("digit_uuid");
  });

  it("returns 401 for bad KC credentials", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () =>
        Promise.resolve({
          error: "invalid_grant",
          error_description: "Invalid user credentials",
        }),
    }) as any;

    await expect(
      controller.login({
        email: "test@example.com",
        password: "wrong-password",
      }),
    ).rejects.toThrow(HttpException);

    try {
      await controller.login({
        email: "test@example.com",
        password: "wrong-password",
      });
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(401);
    }
  });

  it("registers a new user (POST /auth/register)", async () => {
    // Mock admin token fetch
    const fetchMock = vi.fn();

    // First call: admin token
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "admin-token" }),
    });

    // Second call: create user
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
    });

    globalThis.fetch = fetchMock;

    const result = await controller.register({
      email: "newuser@example.com",
      password: "password123",
      name: "New User",
    });

    expect(result).toEqual({ success: true, email: "newuser@example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects register without required fields", async () => {
    await expect(
      controller.register({ email: "", password: "", name: "" }),
    ).rejects.toThrow(HttpException);

    try {
      await controller.register({ email: "", password: "", name: "" });
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(400);
    }
  });

  it("checks email existence", async () => {
    // Mock admin token
    const fetchMock = vi.fn();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "admin-token" }),
    });

    // Mock user search - user found
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ email: "exists@example.com" }]),
    });

    globalThis.fetch = fetchMock;

    const result = await controller.checkEmail("exists@example.com");
    expect(result).toEqual({ exists: true });
  });
});
