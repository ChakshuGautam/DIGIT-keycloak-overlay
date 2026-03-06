import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestApp, stopTestApp, getAppPort, clearCache } from "./test-app.js";
import { getCached, setCached } from "../../src/cache.js";
import { signJwt } from "../helpers.js";

beforeAll(async () => {
  await startTestApp();
});

afterAll(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearCache();
});

describe("E2E: user sync", () => {
  it("updates cached name when Keycloak name changes", async () => {
    // Pre-populate cache with old name
    await setCached("sync-user", "pg.citya", {
      user: {
        uuid: "sync-uuid",
        userName: "sync@test.com",
        name: "Old Name",
        emailId: "sync@test.com",
        mobileNumber: "9000011111",
        tenantId: "pg.citya",
        type: "CITIZEN",
        roles: [{ code: "CITIZEN", name: "Citizen" }],
      },
      cachedAt: Date.now(),
    });

    // Request with new name in JWT
    const token = await signJwt({
      sub: "sync-user",
      email: "sync@test.com",
      name: "New Name",
    });
    await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
      },
    );

    const cached = await getCached("sync-user", "pg.citya");
    expect(cached!.user.name).toBe("New Name");
  });
});
