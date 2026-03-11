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
  it("proxies request with valid JWT and injects RequestInfo with citizen token", async () => {
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
    // Citizen token is per-user, not the system token
    expect(body.receivedRequestInfo.authToken).toMatch(/^token-for-/);
    expect(body.receivedRequestInfo.userInfo.emailId).toBe("e2e@test.com");
    expect(body.receivedRequestInfo.userInfo.type).toBe("CITIZEN");
  });

  it("forwards request without Authorization header to gateway unchanged", async () => {
    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ RequestInfo: { authToken: "existing-digit-token" } }),
      },
    );
    // Non-KC requests are forwarded to gateway (not rejected)
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.echo).toBe(true);
    // Original body is passed through unchanged
    expect(body.receivedBody.RequestInfo.authToken).toBe("existing-digit-token");
  });

  it("forwards request with expired JWT to gateway unchanged", async () => {
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
    // Expired/invalid KC JWTs result in forwarding to gateway
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.echo).toBe(true);
  });
});
