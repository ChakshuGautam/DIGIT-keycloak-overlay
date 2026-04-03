import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
} from "jose";
import type { KeyLike, JWK } from "jose";
import { JwtService } from "./jwt.service";

let privateKey: KeyLike;
let publicJwk: JWK;

const mockConfigService = {
  get: (key: string) =>
    ({ KEYCLOAK_AUDIENCE: "digit-sandbox-ui" } as Record<string, string>)[key],
};

async function makeJwt(overrides: Record<string, any> = {}) {
  return new SignJWT({
    sub: "user-1",
    email: "test@example.com",
    name: "Test User",
    realm_access: { roles: ["CITIZEN"] },
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer("http://keycloak:8080/realms/test-realm")
    .setAudience(overrides.aud || "digit-sandbox-ui")
    .setExpirationTime(overrides.exp || "1h")
    .sign(privateKey);
}

describe("JwtService", () => {
  let service: JwtService;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey;
    const jwk = await exportJWK(keyPair.publicKey);
    publicJwk = { ...jwk, kid: "test-kid", alg: "RS256", use: "sig" };
  });

  beforeEach(() => {
    service = new JwtService(mockConfigService as any);
    (service as any).jwksCache.set(
      "test-realm",
      createLocalJWKSet({ keys: [publicJwk] }),
    );
  });

  it("validates a correct JWT and returns claims", async () => {
    const token = await makeJwt();
    const claims = await service.validate(`Bearer ${token}`);

    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("user-1");
    expect(claims!.email).toBe("test@example.com");
    expect(claims!.realm).toBe("test-realm");
    expect(claims!.roles).toEqual(["CITIZEN"]);
  });

  it("rejects JWT with wrong audience", async () => {
    const token = await makeJwt({ aud: "wrong-audience" });
    const claims = await service.validate(`Bearer ${token}`);

    expect(claims).toBeNull();
  });

  it("rejects expired JWT", async () => {
    const token = await makeJwt({ exp: "0s" });
    // Wait for the token to expire
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const claims = await service.validate(`Bearer ${token}`);

    expect(claims).toBeNull();
  });

  it("returns null for missing auth header", async () => {
    const claims = await service.validate(undefined);
    expect(claims).toBeNull();

    const claims2 = await service.validate("Basic abc123");
    expect(claims2).toBeNull();
  });

  it("returns null for malformed token", async () => {
    const claims = await service.validate("Bearer not.a.valid.jwt");
    expect(claims).toBeNull();
  });

  it("returns null for JWT missing email claim", async () => {
    const token = await new SignJWT({
      sub: "user-1",
      name: "No Email User",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer("http://keycloak:8080/realms/test-realm")
      .setAudience("digit-sandbox-ui")
      .setExpirationTime("1h")
      .sign(privateKey);

    const claims = await service.validate(`Bearer ${token}`);
    expect(claims).toBeNull();
  });

  it("extracts realm name from issuer URL", async () => {
    const token = await makeJwt();
    const claims = await service.validate(`Bearer ${token}`);
    expect(claims).not.toBeNull();
    expect(claims!.realm).toBe("test-realm");
  });

  it("extracts roles from realm_access", async () => {
    const token = await makeJwt({
      realm_access: { roles: ["EMPLOYEE", "GRO"] },
    });
    const claims = await service.validate(`Bearer ${token}`);
    expect(claims).not.toBeNull();
    expect(claims!.roles).toEqual(["EMPLOYEE", "GRO"]);
  });

  it("returns empty roles when realm_access is missing", async () => {
    // Build a JWT without realm_access
    const token = await new SignJWT({
      sub: "user-1",
      email: "test@example.com",
      name: "Test User",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer("http://keycloak:8080/realms/test-realm")
      .setAudience("digit-sandbox-ui")
      .setExpirationTime("1h")
      .sign(privateKey);

    const claims = await service.validate(`Bearer ${token}`);
    expect(claims).not.toBeNull();
    expect(claims!.roles).toEqual([]);
  });
});
