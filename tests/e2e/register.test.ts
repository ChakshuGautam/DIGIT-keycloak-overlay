import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, stopTestApp, getAppPort } from "./test-app.js";

beforeAll(async () => {
  await startTestApp();
});

afterAll(async () => {
  await stopTestApp();
});

describe("E2E: POST /register", () => {
  it("creates user (201)", async () => {
    const resp = await fetch(`http://localhost:${getAppPort()}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "register-test@example.com",
        password: "SecurePass123",
        name: "Register Test",
      }),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as any;
    expect(body.success).toBe(true);
    expect(body.email).toBe("register-test@example.com");
  });

  it("returns 400 when fields missing", async () => {
    const resp = await fetch(`http://localhost:${getAppPort()}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "incomplete@example.com" }),
    });

    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("required");
  });

  it("returns 409 when user already exists", async () => {
    // Create the user first
    await fetch(`http://localhost:${getAppPort()}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "duplicate-e2e@example.com",
        password: "SecurePass123",
        name: "First Registration",
      }),
    });

    // Try to register again with the same email
    const resp = await fetch(`http://localhost:${getAppPort()}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "duplicate-e2e@example.com",
        password: "SecurePass123",
        name: "Duplicate Registration",
      }),
    });

    expect(resp.status).toBe(409);
    const body = (await resp.json()) as any;
    expect(body.error).toBe("User already exists");
  });
});

describe("E2E: GET /check-email", () => {
  it("returns {exists: true} for existing user", async () => {
    // Create a user first via /register
    await fetch(`http://localhost:${getAppPort()}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "check-exists@example.com",
        password: "SecurePass123",
        name: "Check Exists",
      }),
    });

    const resp = await fetch(
      `http://localhost:${getAppPort()}/check-email?email=check-exists@example.com`,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.exists).toBe(true);
  });

  it("returns {exists: false} for unknown user", async () => {
    const resp = await fetch(
      `http://localhost:${getAppPort()}/check-email?email=unknown@example.com`,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.exists).toBe(false);
  });

  it("returns 400 when email param missing", async () => {
    const resp = await fetch(
      `http://localhost:${getAppPort()}/check-email`,
    );

    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("email");
  });
});
