import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { MetricsService } from "../metrics/metrics.service";
import { DigitClientService } from "./digit-client.service";
import { rootTenant } from "../routes";
import type { JwtClaims, DigitUser, CachedSession } from "../types";

const DIGIT_ROLES = new Set([
  "CITIZEN", "EMPLOYEE", "SUPERUSER", "GRO", "PGR_LME", "DGRO", "CSR",
  "SUPERVISOR", "AUTO_ESCALATE", "PGR_VIEWER", "TICKET_REPORT_VIEWER",
  "LOC_ADMIN", "MDMS_ADMIN", "HRMS_ADMIN", "WORKFLOW_ADMIN",
  "COMMON_EMPLOYEE", "REINDEXING_ROLE", "QA_AUTOMATION", "SYSTEM",
  "ANONYMOUS", "INTERNAL_MICROSERVICE_ROLE",
]);

@Injectable()
export class UserResolverService {
  private readonly logger = new Logger(UserResolverService.name);

  constructor(
    private readonly cache: CacheService,
    private readonly digit: DigitClientService,
    private readonly metrics: MetricsService,
  ) {}

  async resolve(
    claims: JwtClaims,
    tenantId: string,
  ): Promise<{ user: DigitUser; token: string }> {
    const root = rootTenant(tenantId);
    const cached = await this.cache.get(claims.sub, tenantId);

    if (cached) {
      this.metrics.cacheOpsTotal.inc({ op: "get", result: "hit" });
      return this.handleCacheHit(claims, tenantId, root, cached);
    }

    this.metrics.cacheOpsTotal.inc({ op: "get", result: "miss" });
    return this.handleCacheMiss(claims, tenantId, root);
  }

  private async handleCacheHit(
    claims: JwtClaims,
    tenantId: string,
    root: string,
    cached: CachedSession,
  ): Promise<{ user: DigitUser; token: string }> {
    const userName = cached.user.userName;
    let { user } = cached;
    let token = cached.token ?? "";

    // Re-validate stale sessions
    if (this.cache.isStale(cached)) {
      const freshUser = await this.digit.searchUser(userName, root);
      if (!freshUser || freshUser.active === false) {
        await this.cache.delete(claims.sub, tenantId);
        throw new Error("User deactivated");
      }
      user = freshUser;
    }

    // Sync name if changed
    if (claims.name && claims.name !== user.name) {
      user = { ...user, name: claims.name };
    }

    // Sync roles
    const jwtRoles = this.extractDigitRoles(claims);
    const cachedRoleCodes = new Set(user.roles.map((r) => r.code));
    const jwtRoleCodes = new Set(jwtRoles.map((r) => r.code));
    const rolesChanged =
      cachedRoleCodes.size !== jwtRoleCodes.size ||
      [...jwtRoleCodes].some((code) => !cachedRoleCodes.has(code));

    if (rolesChanged) {
      await this.digit.updateUserRoles(user, jwtRoles);
      user = { ...user, roles: jwtRoles };
      this.metrics.roleSyncTotal.inc({ direction: "kc_to_digit", result: "success" });
    }

    // Token refresh
    const userType = this.digit.resolveUserType(claims.roles);
    if (!cached.tokenExpiry || cached.tokenExpiry < Date.now()) {
      const tokenResult = await this.digit.getUserToken(
        userName,
        cached.password,
        root,
        userType,
      );
      token = tokenResult.token;
      const tokenExpiry = Date.now() + tokenResult.expiresIn;

      await this.cache.set(claims.sub, tenantId, {
        user,
        password: cached.password,
        cachedAt: Date.now(),
        token,
        tokenExpiry,
      });
    } else if (rolesChanged) {
      await this.cache.set(claims.sub, tenantId, {
        ...cached,
        user,
        cachedAt: Date.now(),
      });
    }

    return { user, token };
  }

  private async handleCacheMiss(
    claims: JwtClaims,
    tenantId: string,
    root: string,
  ): Promise<{ user: DigitUser; token: string }> {
    const userName = this.digit.namespacedUserName(claims.realm, claims.email);
    let password = this.digit.generateRandomPassword();
    const userType = this.digit.resolveUserType(claims.roles);
    const jwtRoles = this.extractDigitRoles(claims);

    let user = await this.digit.searchUser(userName, root);

    // Fallback: search by preferred_username first (maps to actual DIGIT userName, e.g., "ADMIN")
    if (!user && claims.preferred_username) {
      user = await this.digit.searchUser(claims.preferred_username, root);
      if (!user && claims.preferred_username !== claims.preferred_username.toUpperCase()) {
        user = await this.digit.searchUser(claims.preferred_username.toUpperCase(), root);
      }
    }

    // Fallback: search by plain email
    if (!user) {
      user = await this.digit.searchUser(claims.email, root);
    }

    if (user) {
      // Existing user: try getting token with the user's existing password
      // For KC-provisioned users, we don't know the password, so we'll set one
      this.metrics.userProvisionTotal.inc({ result: "existing" });
    } else {
      // New user: create
      user = await this.digit.createUser({
        userName,
        name: claims.name ?? claims.email,
        email: claims.email,
        tenantId: root,
        password,
        keycloakSub: claims.sub,
        type: userType,
        roles: jwtRoles,
      });
      this.metrics.userProvisionTotal.inc({ result: "created" });
    }

    // Try to get DIGIT token — for existing users, try multiple password strategies
    let tokenResult: { token: string; expiresIn: number };
    const effectiveUserName = user.userName;
    // Use actual user type from DIGIT (more reliable than JWT for existing users)
    const effectiveUserType = user.type || userType;
    this.logger.log(`Token acquisition: userName=${effectiveUserName}, type=${effectiveUserType}, tenant=${root}`);
    try {
      // Strategy 1: random password (new users created by v2)
      tokenResult = await this.digit.getUserToken(effectiveUserName, password, root, effectiveUserType);
    } catch {
      try {
        // Strategy 2: v1 deterministic password (existing users created by v1)
        const v1Password = this.digit.generateV1Password(claims.sub);
        tokenResult = await this.digit.getUserToken(effectiveUserName, v1Password, root, effectiveUserType);
        password = v1Password;
      } catch {
        // Strategy 3: system default password (pre-existing DIGIT users like ADMIN)
        const defaultPassword = this.digit.getSystemPassword();
        tokenResult = await this.digit.getUserToken(effectiveUserName, defaultPassword, root, effectiveUserType);
        password = defaultPassword;
      }
    }
    const token = tokenResult.token;
    const tokenExpiry = Date.now() + tokenResult.expiresIn;

    await this.cache.set(claims.sub, tenantId, {
      user,
      password,
      cachedAt: Date.now(),
      token,
      tokenExpiry,
    });

    return { user, token };
  }

  private extractDigitRoles(claims: JwtClaims): Array<{ code: string; name: string }> {
    return claims.roles
      .filter((role) => DIGIT_ROLES.has(role))
      .map((role) => ({ code: role, name: role }));
  }
}
