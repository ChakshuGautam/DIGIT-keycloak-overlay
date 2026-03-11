import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestApp, stopTestApp, getAppPort, clearCache } from "./test-app.js";
import { config } from "../../src/config.js";
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

describe("E2E: proxy content-path branches", () => {
  it("preserves query string when proxying to gateway", async () => {
    const token = await signJwt({
      sub: "qs-user-1",
      email: "qs@test.com",
      name: "QS User",
    });

    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search?tenantId=pg.citya&status=OPEN`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          RequestInfo: { apiId: "Rainmaker" },
        }),
      },
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.echo).toBe(true);
    expect(body.query).toBeTruthy();
    expect(body.query.tenantId).toBe("pg.citya");
    expect(body.query.status).toBe("OPEN");
  });

  it("returns 502 when gateway is unreachable", async () => {
    const token = await signJwt({
      sub: "502-user-1",
      email: "bad@test.com",
      name: "Bad Gateway User",
    });

    // Temporarily point gateway to a dead port
    const savedGateway = config.digitGatewayHost;
    (config as any).digitGatewayHost = "http://localhost:1";

    try {
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
          }),
        },
      );

      expect(resp.status).toBe(502);
      const body = (await resp.json()) as any;
      expect(body.error).toBe("Bad gateway");
      expect(body.details).toBeTruthy();
    } finally {
      (config as any).digitGatewayHost = savedGateway;
    }
  });

  it("forwards pass-through content type with Authorization header (not RequestInfo)", async () => {
    const token = await signJwt({
      sub: "pt-user-1",
      email: "passthrough@test.com",
      name: "Pass-Through User",
    });

    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "GET",
        headers: {
          "Content-Type": "text/plain",
          Authorization: `Bearer ${token}`,
        },
      },
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.echo).toBe(true);
    // Pass-through branch sets Authorization header instead of rewriting RequestInfo
    expect(body.headers.authorization).toMatch(/^Bearer /);
    // Should NOT have RequestInfo injected (that is the JSON branch behavior)
    expect(body.receivedRequestInfo).toBeNull();
  });
});
