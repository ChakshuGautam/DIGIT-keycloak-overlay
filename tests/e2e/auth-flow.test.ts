import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestApp, stopTestApp, getAppPort, clearCache } from "./test-app.js";
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

describe("E2E: auth flow", () => {
  it("proxies request with valid JWT and injects RequestInfo", async () => {
    const token = await signJwt({
      sub: "e2e-user-1",
      email: "e2e@test.com",
      name: "E2E User",
    });

    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          RequestInfo: { apiId: "Rainmaker" },
          tenantId: "pg.citya",
        }),
      },
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.echo).toBe(true);
    expect(body.receivedRequestInfo.authToken).toBeTruthy();
    expect(body.receivedRequestInfo.userInfo.emailId).toBe("e2e@test.com");
    expect(body.receivedRequestInfo.userInfo.type).toBe("CITIZEN");
  });

  it("returns 401 for request without Authorization header", async () => {
    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ RequestInfo: {} }),
      },
    );
    expect(resp.status).toBe(401);
  });

  it("returns 401 for expired JWT", async () => {
    const token = await signJwt(
      { sub: "e2e-expired", email: "exp@test.com" },
      { expiresIn: "0s" },
    );
    await new Promise((r) => setTimeout(r, 1100));

    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ RequestInfo: {} }),
      },
    );
    expect(resp.status).toBe(401);
  });
});
