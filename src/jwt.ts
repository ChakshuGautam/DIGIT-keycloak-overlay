import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type FlattenedJWSInput, type JWSHeaderParameters, type KeyLike } from "jose";
import { config } from "./config.js";
import type { KCClaims } from "./types.js";

/**
 * Custom JWKS fetcher that uses native fetch() instead of jose's internal
 * http.get. This ensures the OTEL undici instrumentation propagates
 * traceparent to Keycloak, linking JWKS fetches into the parent trace.
 */
function createTracedRemoteJWKSet(url: URL, opts?: { cooldownDuration?: number }) {
  let cachedJwks: ReturnType<typeof createLocalJWKSet> | null = null;
  let lastFetch = 0;
  let pendingFetch: Promise<void> | null = null;
  const cooldown = opts?.cooldownDuration ?? 30_000;

  async function refreshJwks(): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const json = (await res.json()) as JSONWebKeySet;
    cachedJwks = createLocalJWKSet(json);
    lastFetch = Date.now();
  }

  return async (protectedHeader?: JWSHeaderParameters, token?: FlattenedJWSInput): Promise<KeyLike> => {
    const stale = !cachedJwks || Date.now() - lastFetch > cooldown;
    if (stale) {
      // Deduplicate concurrent fetches
      pendingFetch ??= refreshJwks().finally(() => { pendingFetch = null; });
      await pendingFetch;
    }
    return cachedJwks!(protectedHeader, token);
  };
}

let jwks: ReturnType<typeof createTracedRemoteJWKSet>;

export function initJwks(jwksUri?: string) {
  jwks = createTracedRemoteJWKSet(new URL(jwksUri || config.keycloakJwksUri));
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
      realm_access: (payload.realm_access as { roles: string[] }) || undefined,
      groups: (payload.groups as string[]) || undefined,
    };
  } catch {
    return null;
  }
}
