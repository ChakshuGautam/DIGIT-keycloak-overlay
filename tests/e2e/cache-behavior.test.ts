import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestApp, stopTestApp, getAppPort, clearCache } from "./test-app.js";
import { setCached } from "../../src/cache.js";
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

describe("E2E: cache behavior", () => {
  it("serves from cache on second request", async () => {
    const token = await signJwt({
      sub: "cache-user",
      email: "cache@test.com",
      name: "Cache",
    });
    const url = `http://localhost:${getAppPort()}/pgr-services/v2/_search`;
    const opts = {
      method: "POST" as const,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
    };

    // First request (provisions)
    const r1 = await fetch(url, opts);
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as any;

    // Second request (cache hit)
    const r2 = await fetch(url, opts);
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as any;

    // Same user UUID in both
    expect(b2.receivedRequestInfo.userInfo.uuid).toBe(
      b1.receivedRequestInfo.userInfo.uuid,
    );
  });

  it("uses pre-populated cache entry with valid token", async () => {
    await setCached("pre-cached", "pg.citya", {
      user: {
        uuid: "pre-uuid",
        userName: "pre@test.com",
        name: "Pre Cached",
        emailId: "pre@test.com",
        mobileNumber: "9000099999",
        tenantId: "pg.citya",
        type: "CITIZEN",
        roles: [{ code: "CITIZEN", name: "Citizen" }],
      },
      cachedAt: Date.now(),
      token: "pre-cached-citizen-token",
      tokenExpiry: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    const token = await signJwt({
      sub: "pre-cached",
      email: "pre@test.com",
      name: "Pre Cached",
    });
    const resp = await fetch(
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
    const body = (await resp.json()) as any;
    expect(body.receivedRequestInfo.userInfo.uuid).toBe("pre-uuid");
    // Uses the pre-cached citizen token
    expect(body.receivedRequestInfo.authToken).toBe("pre-cached-citizen-token");
  });
});
