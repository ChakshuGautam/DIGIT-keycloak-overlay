import type { KCClaims, DigitUser, CachedSession } from "./types.js";
import { getCached, setCached } from "./cache.js";
import { searchUser, createUser, updateUser } from "./digit-client.js";
import { config } from "./config.js";

export async function resolveUser(
  claims: KCClaims,
  tenantId: string,
): Promise<DigitUser> {
  const effectiveTenant = tenantId || config.digitDefaultTenant;

  // 1. Check cache
  const cached = await getCached(claims.sub, effectiveTenant);
  if (cached) {
    // Sync check: has name or email changed in Keycloak?
    const nameChanged = claims.name && cached.user.name !== claims.name;
    const emailChanged = cached.user.emailId !== claims.email;
    if (nameChanged || emailChanged) {
      const updates: { name?: string; emailId?: string } = {};
      if (nameChanged) updates.name = claims.name!;
      if (emailChanged) updates.emailId = claims.email;
      await updateUser(cached.user.uuid, updates).catch(() => {}); // best-effort
      cached.user.name = claims.name || cached.user.name;
      cached.user.emailId = claims.email;
      await setCached(claims.sub, effectiveTenant, cached);
    }
    return cached.user;
  }

  // 2. Search for existing DIGIT user by email
  let digitUser = await searchUser(claims.email, effectiveTenant);

  // 3. Lazy provision if not found
  if (!digitUser) {
    digitUser = await createUser({
      name: claims.name || claims.preferred_username || claims.email,
      email: claims.email,
      tenantId: effectiveTenant,
      keycloakSub: claims.sub,
      phoneNumber: claims.phone_number,
    });
  }

  // 4. Cache
  const session: CachedSession = { user: digitUser, cachedAt: Date.now() };
  await setCached(claims.sub, effectiveTenant, session);

  return digitUser;
}
