import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestApp,
  stopTestApp,
  getAppPort,
  clearCache,
} from "./test-app.js";

beforeAll(async () => {
  await startTestApp();
});

afterAll(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearCache();
});

describe("E2E: CORS preflight", () => {
  it("returns 204 for OPTIONS request with CORS headers", async () => {
    const resp = await fetch(
      `http://localhost:${getAppPort()}/pgr-services/v2/_search`,
      { method: "OPTIONS" },
    );

    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    expect(resp.headers.get("access-control-allow-methods")).toContain("POST");
    expect(resp.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
  });
});

describe("E2E: healthz", () => {
  it("returns 200 with redis connected", async () => {
    const resp = await fetch(`http://localhost:${getAppPort()}/healthz`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.redis).toBe("connected");
  });
});
