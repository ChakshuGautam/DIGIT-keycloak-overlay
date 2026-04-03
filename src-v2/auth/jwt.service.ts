import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { jwtVerify, createRemoteJWKSet } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { JwtClaims } from "../types";

@Injectable()
export class JwtService {
  private readonly audience: string;
  private readonly jwksCache = new Map<string, JWTVerifyGetKey>();

  constructor(private readonly config: ConfigService) {
    this.audience = this.config.get<string>("KEYCLOAK_AUDIENCE") || "digit-ui";
  }

  async validate(authHeader: string | undefined): Promise<JwtClaims | null> {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.slice(7);

    try {
      // Decode payload to extract issuer and realm
      const parts = token.split(".");
      if (parts.length !== 3) {
        return null;
      }

      const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
      const payload = JSON.parse(payloadJson);
      const iss: string | undefined = payload.iss;

      if (!iss) {
        return null;
      }

      // Extract realm from issuer URL: .../realms/<realm>
      const realmMatch = iss.match(/\/realms\/([^/]+)$/);
      if (!realmMatch) {
        return null;
      }
      const realm = realmMatch[1];

      // Get or create JWKS for this realm
      const jwks = this.getJwks(realm, iss);

      // Verify the token
      const { payload: verified } = await jwtVerify(token, jwks, {
        issuer: iss,
        audience: this.audience,
      });

      const sub = verified.sub;
      const email = verified.email as string | undefined;

      if (!sub || !email) {
        return null;
      }

      const realmAccess = verified.realm_access as
        | { roles?: string[] }
        | undefined;

      return {
        sub,
        email,
        name: (verified.name as string) || undefined,
        preferred_username:
          (verified.preferred_username as string) || undefined,
        phone_number: (verified.phone_number as string) || undefined,
        email_verified: (verified.email_verified as boolean) || undefined,
        realm,
        roles: realmAccess?.roles || [],
        groups: (verified.groups as string[]) || undefined,
      };
    } catch {
      return null;
    }
  }

  extractSubFromToken(authHeader: string): string | null {
    try {
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : authHeader;
      const parts = token.split(".");
      if (parts.length !== 3) {
        return null;
      }
      const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
      const payload = JSON.parse(payloadJson);
      return payload.sub || null;
    } catch {
      return null;
    }
  }

  private getJwks(realm: string, issuer: string): JWTVerifyGetKey {
    let jwks = this.jwksCache.get(realm);
    if (!jwks) {
      const jwksUri = `${issuer}/protocol/openid-connect/certs`;
      jwks = createRemoteJWKSet(new URL(jwksUri));
      this.jwksCache.set(realm, jwks);
    }
    return jwks;
  }
}
