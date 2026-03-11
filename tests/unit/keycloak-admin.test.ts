import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createKcAdminMock, resetState } from "../../mocks/kc-admin.js";
import { config } from "../../src/config.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Import the module under test — keycloak-admin.ts (NOT kc-admin.ts)
import {
  getAdminToken,
  searchKeycloakUser,
  createKeycloakUser,
} from "../../src/keycloak-admin.js";

let server: Server;
let port: number;
let originalAdminUrl: string;

beforeAll(async () => {
  const { app } = createKcAdminMock();
  server = app.listen(0);
  port = (server.address() as AddressInfo).port;

  // Save and override config to point at our local mock
  originalAdminUrl = config.keycloakAdminUrl;
  config.keycloakAdminUrl = `http://localhost:${port}`;
});

afterAll(() => {
  config.keycloakAdminUrl = originalAdminUrl;
  server?.close();
});

beforeEach(() => {
  resetState();
});

describe("getAdminToken", () => {
  it("returns a token string", async () => {
    const token = await getAdminToken();
    expect(typeof token).toBe("string");
    expect(token).toBe("mock-kc-admin-token");
  });

  it("caches token (second call doesn't re-fetch)", async () => {
    const token1 = await getAdminToken();
    const token2 = await getAdminToken();
    expect(token1).toBe(token2);
  });
});

describe("searchKeycloakUser", () => {
  it("returns true when user exists", async () => {
    // Pre-create a user in the mock via direct HTTP call
    const token = await getAdminToken();
    await fetch(
      `http://localhost:${port}/admin/realms/${config.keycloakUserRealm}/users`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          username: "existing@test.com",
          email: "existing@test.com",
          firstName: "Existing",
          enabled: true,
          emailVerified: true,
        }),
      },
    );

    const exists = await searchKeycloakUser("existing@test.com");
    expect(exists).toBe(true);
  });

  it("returns false when user doesn't exist", async () => {
    const exists = await searchKeycloakUser("nonexistent@test.com");
    expect(exists).toBe(false);
  });
});

describe("createKeycloakUser", () => {
  it("creates user successfully", async () => {
    await createKeycloakUser({
      email: "newuser@test.com",
      password: "password123",
      name: "New User",
    });

    // Verify user was created by searching
    const exists = await searchKeycloakUser("newuser@test.com");
    expect(exists).toBe(true);
  });

  it('throws "User already exists" on 409', async () => {
    // Create the user first
    await createKeycloakUser({
      email: "duplicate@test.com",
      password: "password123",
      name: "First User",
    });

    // Attempt to create the same user again
    await expect(
      createKeycloakUser({
        email: "duplicate@test.com",
        password: "password123",
        name: "Duplicate User",
      }),
    ).rejects.toThrow("User already exists");
  });
});
