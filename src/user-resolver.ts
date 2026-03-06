import type { KCClaims, DigitUser, CachedSession } from "./types.js";
import { getCached, setCached } from "./cache.js";
import { searchUser, createUser, updateUser, updateUserRoles } from "./digit-client.js";
import { config } from "./config.js";

// Known DIGIT role codes (from access_roles_search)
const DIGIT_ROLES = new Set([
  "CITIZEN", "EMPLOYEE", "SUPERUSER", "GRO", "PGR_LME", "DGRO", "CSR",
  "SUPERVISOR", "AUTO_ESCALATE", "PGR_VIEWER", "TICKET_REPORT_VIEWER",
  "LOC_ADMIN", "MDMS_ADMIN", "HRMS_ADMIN", "WORKFLOW_ADMIN",
  "COMMON_EMPLOYEE", "REINDEXING_ROLE", "QA_AUTOMATION", "SYSTEM", "ANONYMOUS",
  "INTERNAL_MICROSERVICE_ROLE",
]);

function extractDigitRoles(claims: KCClaims): Array<{ code: string; name: string }> {
  const kcRoles = claims.realm_access?.roles || [];
  return kcRoles
    .filter(r => DIGIT_ROLES.has(r))
    .map(r => ({ code: r, name: r }));
}

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

    // Role sync: compare KC roles with cached DIGIT roles
    const desiredRoles = extractDigitRoles(claims);
    if (desiredRoles.length > 0) {
      const cachedRoleCodes = new Set(cached.user.roles.map(r => r.code));
      const desiredRoleCodes = new Set(desiredRoles.map(r => r.code));
      desiredRoleCodes.add("CITIZEN");
      const rolesChanged = desiredRoleCodes.size !== cachedRoleCodes.size ||
        [...desiredRoleCodes].some(r => !cachedRoleCodes.has(r));
      if (rolesChanged) {
        await updateUserRoles(cached.user.uuid, effectiveTenant, desiredRoles).catch(() => {});
        const allRoles = [...desiredRoles];
        if (!allRoles.find(r => r.code === "CITIZEN")) {
          allRoles.push({ code: "CITIZEN", name: "Citizen" });
        }
        cached.user.roles = allRoles;
        await setCached(claims.sub, effectiveTenant, cached);
      }
    }

    return cached.user;
  }

  // 2. Search for existing DIGIT user by email
  let digitUser = await searchUser(claims.email, effectiveTenant);

  // 3. Lazy provision if not found
  if (!digitUser) {
    const roles = extractDigitRoles(claims);
    digitUser = await createUser({
      name: claims.name || claims.preferred_username || claims.email,
      email: claims.email,
      tenantId: effectiveTenant,
      keycloakSub: claims.sub,
      phoneNumber: claims.phone_number,
      roles: roles.length > 0 ? roles : undefined,
    });
  }

  // 4. Cache
  const session: CachedSession = { user: digitUser, cachedAt: Date.now() };
  await setCached(claims.sub, effectiveTenant, session);

  return digitUser;
}
