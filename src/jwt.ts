import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.js";
import type { KCClaims } from "./types.js";

let jwks: ReturnType<typeof createRemoteJWKSet>;

export function initJwks(jwksUri?: string) {
  jwks = createRemoteJWKSet(new URL(jwksUri || config.keycloakJwksUri));
}

export async function validateJwt(
  authHeader: string | undefined,
): Promise<KCClaims | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.keycloakIssuer,
    });
    if (!payload.sub || !payload.email) return null;
    return {
      sub: payload.sub,
      email: payload.email as string,
      name: (payload.name as string) || undefined,
      preferred_username:
        (payload.preferred_username as string) || undefined,
      email_verified: payload.email_verified as boolean | undefined,
      phone_number: (payload.phone_number as string) || undefined,
    };
  } catch {
    return null;
  }
}
