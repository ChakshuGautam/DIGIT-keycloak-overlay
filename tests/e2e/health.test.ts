import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, stopTestApp, getAppPort } from "./test-app.js";

beforeAll(async () => {
  await startTestApp();
});

afterAll(async () => {
  await stopTestApp();
});

describe("E2E: health check", () => {
  it("returns ok when Redis is connected", async () => {
    const resp = await fetch(`http://localhost:${getAppPort()}/healthz`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.redis).toBe("connected");
  });
});
