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
  it("returns 401 for garbage token", async () => {
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
    expect(resp.status).toBe(401);
  });

  it("returns 404 for unknown upstream path", async () => {
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
    expect(resp.status).toBe(404);
  });
});
