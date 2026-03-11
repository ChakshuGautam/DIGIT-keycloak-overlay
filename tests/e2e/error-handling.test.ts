import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, stopTestApp, getAppPort } from "./test-app.js";
import { signJwt } from "../helpers.js";

beforeAll(async () => {
  await startTestApp();
});

afterAll(async () => {
  await stopTestApp();
});

describe("E2E: error handling", () => {
  it("forwards garbage token to gateway (non-KC passthrough)", async () => {
    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer garbage",
        },
        body: JSON.stringify({ RequestInfo: {} }),
      },
    );
    // Garbage tokens are not valid KC JWTs, so request is forwarded to gateway
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.echo).toBe(true);
  });

  it("forwards unknown path to gateway (gateway handles routing)", async () => {
    const token = await signJwt({
      sub: "err-user",
      email: "err@test.com",
      name: "Err",
    });
    const resp = await fetch(
      `http://localhost:${getAppPort()}/unknown-service/foo`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
      },
    );
    // All paths are forwarded to gateway — gateway handles service routing
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.echo).toBe(true);
    expect(body.path).toBe("/unknown-service/foo");
  });
});
