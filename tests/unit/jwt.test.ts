import { describe, it, expect, beforeAll } from "vitest";
import { initJwks, validateJwt } from "../../src/jwt.js";
import { signJwt } from "../helpers.js";

beforeAll(() => {
  initJwks(process.env.KEYCLOAK_JWKS_URI);
});

describe("validateJwt", () => {
  it("returns claims for a valid JWT", async () => {
    const token = await signJwt({
      sub: "user-1",
      email: "a@b.com",
      name: "Alice",
    });
    const claims = await validateJwt(`Bearer ${token}`);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("user-1");
    expect(claims!.email).toBe("a@b.com");
    expect(claims!.name).toBe("Alice");
  });

  it("returns null for missing auth header", async () => {
    expect(await validateJwt(undefined)).toBeNull();
  });

  it("returns null for non-Bearer header", async () => {
    expect(await validateJwt("Basic abc123")).toBeNull();
  });

  it("returns null for expired JWT", async () => {
    const token = await signJwt(
      { sub: "user-1", email: "a@b.com" },
      { expiresIn: "0s" },
    );
    await new Promise((r) => setTimeout(r, 1100));
    expect(await validateJwt(`Bearer ${token}`)).toBeNull();
  });

  it("returns null for JWT missing email claim", async () => {
    const token = await signJwt({ sub: "user-1" });
    expect(await validateJwt(`Bearer ${token}`)).toBeNull();
  });

  it("returns null for garbage token", async () => {
    expect(await validateJwt("Bearer not.a.real.jwt")).toBeNull();
  });
});
