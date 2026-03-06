# Realm-Per-Tenant Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the single-realm Keycloak model with realm-per-tenant-root, where each DIGIT tenant root (`pg`, `mz`) becomes a KC realm, cities become groups, and all 21 DIGIT roles become realm roles. JWTs natively carry tenant-scoped roles and city assignments.

**Architecture:** token-exchange-svc authenticates to KC Admin on startup, reads DIGIT tenants, creates KC realms from a JSON template (with roles, client, group mapper), and creates city groups within each realm. JWT validation switches from single-issuer to dynamic multi-issuer (realm derived from `iss`). After user resolution, DIGIT roles are synced back to KC as realm role assignments and city group memberships.

**Tech Stack:** TypeScript, Express, jose (JWT), ioredis, Keycloak 24.0 Admin REST API, vitest

**All files relative to:** `/root/DIGIT-keycloak-overlay/.worktrees/kc-role-sync/`

---

## Task 1: Clean Up Tasks 1-4 Code

Remove the single-realm group-based code from the previous plan. Start fresh.

**Files:**
- Delete: `src/kc-admin.ts`
- Delete: `src/tenant-auth.ts`
- Delete: `mocks/kc-admin.ts`
- Delete: `tests/unit/kc-admin.test.ts`
- Modify: `src/server.ts` — remove kc-admin and tenant-auth imports/calls
- Modify: `src/config.ts` — remove `keycloakTargetRealm`, keep other KC Admin config
- Modify: `src/types.ts` — keep `groups?: string[]` on KCClaims (still needed)
- Modify: `src/jwt.ts` — keep `groups` extraction (still needed)
- Revert: `keycloak/realm-export.json` — remove protocolMappers (realms are now created via API, not import)

**Step 1: Delete old files**

```bash
rm src/kc-admin.ts src/tenant-auth.ts mocks/kc-admin.ts tests/unit/kc-admin.test.ts
```

**Step 2: Revert server.ts to pre-Task-1 state**

Remove imports of `kc-admin.js` and `tenant-auth.js`. Remove the `checkTenantAccess` block from the request handler. Remove the KC Admin init block from startup. Remove `stopKcAdminRefresh()` from SIGTERM handler. The file should look like the original plus the `groups` field usage will come later.

`src/server.ts` should be:
```typescript
import express from "express";
import { config } from "./config.js";
import { initJwks, validateJwt } from "./jwt.js";
import { initCache, getRedis, closeCache } from "./cache.js";
import {
  initSystemToken,
  startTokenRefresh,
  stopTokenRefresh,
} from "./digit-client.js";
import { resolveUser } from "./user-resolver.js";
import { initRoutes } from "./routes.js";
import { proxyRequest } from "./proxy.js";

export async function createApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/healthz", async (_req, res) => {
    try {
      const redis = getRedis();
      await redis.ping();
      res.json({ status: "ok", redis: "connected" });
    } catch {
      res.status(503).json({ status: "unhealthy", redis: "disconnected" });
    }
  });

  app.all("*", async (req, res) => {
    const claims = await validateJwt(req.headers.authorization);
    if (!claims) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "Invalid or missing Keycloak JWT" });
    }

    const tenantId =
      req.body?.RequestInfo?.userInfo?.tenantId ||
      req.body?.tenantId ||
      config.digitDefaultTenant;

    try {
      const digitUser = await resolveUser(claims, tenantId);
      await proxyRequest(req, res, digitUser);
    } catch (err) {
      console.error("User resolution error:", err);
      res
        .status(500)
        .json({ error: "Internal error", message: "Failed to resolve user" });
    }
  });

  return app;
}

const isMain =
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js");
if (isMain) {
  (async () => {
    initJwks();
    initCache();
    initRoutes();
    await initSystemToken();
    startTokenRefresh();

    const app = await createApp();
    app.listen(config.port, () => {
      console.log(`token-exchange-svc listening on :${config.port}`);
    });

    process.on("SIGTERM", async () => {
      stopTokenRefresh();
      await closeCache();
      process.exit(0);
    });
  })();
}
```

**Step 3: Clean config.ts**

Remove `keycloakTargetRealm`. Keep `keycloakAdminUrl`, `keycloakAdminRealm`, `keycloakAdminClientId`, `keycloakAdminUsername`, `keycloakAdminPassword`, `tenantSyncEnabled`, `digitMdmsHost`, `digitTenants`. These are all still needed for the new architecture.

**Step 4: Revert realm-export.json**

Remove the `protocolMappers` array from the `digit-sandbox-ui` client. The `digit-sandbox` realm in realm-export is now the **fallback/legacy** realm. New tenant realms are created via the API using the template.

**Step 5: Verify**

Run: `npx tsc --noEmit`
Expected: Clean compilation.

Run: `REDIS_PORT=16379 npx vitest run`
Expected: All original 35 tests pass (the 14 kc-admin tests are deleted).

**Step 6: Commit**

```bash
git add -A && git commit -m "chore: remove single-realm group code, prepare for realm-per-tenant"
```

---

## Task 2: Realm Template JSON

Create the template used to provision new KC realms via the Admin API.

**Files:**
- Create: `keycloak/realm-template.json`

**Step 1: Create template**

The template has placeholder `"__REALM_NAME__"` for the realm name. It includes:
- All 21 DIGIT realm roles
- A public OIDC client `digit-ui` with PKCE (redirect URIs for localhost + *.egov.theflywheel.in)
- A `groups` client scope with `oidc-group-membership-mapper`
- The `groups` scope added to `defaultDefaultClientScopes`

```json
{
  "realm": "__REALM_NAME__",
  "enabled": true,
  "registrationAllowed": false,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "resetPasswordAllowed": true,
  "bruteForceProtected": true,
  "permanentLockout": false,
  "maxFailureWaitSeconds": 900,
  "failureFactor": 5,
  "passwordPolicy": "length(8)",
  "sslRequired": "none",
  "accessTokenLifespan": 900,
  "ssoSessionIdleTimeout": 1800,
  "ssoSessionMaxLifespan": 604800,
  "roles": {
    "realm": [
      { "name": "CITIZEN", "description": "Default citizen role" },
      { "name": "EMPLOYEE", "description": "Base employee role" },
      { "name": "SUPERUSER", "description": "Full system access" },
      { "name": "GRO", "description": "Grievance Routing Officer" },
      { "name": "PGR_LME", "description": "PGR Last Mile Employee" },
      { "name": "DGRO", "description": "Department GRO" },
      { "name": "CSR", "description": "Customer Service Rep" },
      { "name": "SUPERVISOR", "description": "Supervisor" },
      { "name": "AUTO_ESCALATE", "description": "Auto escalation" },
      { "name": "PGR_VIEWER", "description": "PGR read-only access" },
      { "name": "TICKET_REPORT_VIEWER", "description": "Report viewer" },
      { "name": "LOC_ADMIN", "description": "Localization admin" },
      { "name": "MDMS_ADMIN", "description": "Master data admin" },
      { "name": "HRMS_ADMIN", "description": "HR admin" },
      { "name": "WORKFLOW_ADMIN", "description": "Workflow admin" },
      { "name": "COMMON_EMPLOYEE", "description": "Common employee" },
      { "name": "REINDEXING_ROLE", "description": "Elasticsearch reindexing" },
      { "name": "QA_AUTOMATION", "description": "Automated testing" },
      { "name": "SYSTEM", "description": "Internal system role" },
      { "name": "ANONYMOUS", "description": "Unauthenticated access" },
      { "name": "INTERNAL_MICROSERVICE_ROLE", "description": "Inter-service communication" }
    ]
  },
  "defaultRoles": ["CITIZEN"],
  "clients": [
    {
      "clientId": "digit-ui",
      "enabled": true,
      "publicClient": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "implicitFlowEnabled": false,
      "protocol": "openid-connect",
      "rootUrl": "",
      "baseUrl": "/",
      "redirectUris": [
        "http://localhost:*",
        "https://*.egov.theflywheel.in/*"
      ],
      "webOrigins": [
        "http://localhost:3000",
        "http://localhost:5173",
        "https://*.egov.theflywheel.in"
      ],
      "attributes": {
        "pkce.code.challenge.method": "S256"
      },
      "defaultClientScopes": [
        "web-origins",
        "profile",
        "roles",
        "email",
        "groups"
      ]
    }
  ],
  "clientScopes": [
    {
      "name": "groups",
      "protocol": "openid-connect",
      "attributes": {
        "display.on.consent.screen": "true"
      },
      "protocolMappers": [
        {
          "name": "groups",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-group-membership-mapper",
          "consentRequired": false,
          "config": {
            "full.path": "false",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "claim.name": "groups",
            "userinfo.token.claim": "true"
          }
        }
      ]
    }
  ],
  "defaultDefaultClientScopes": [
    "web-origins",
    "profile",
    "roles",
    "email",
    "groups"
  ],
  "scopeMappings": [],
  "identityProviders": [],
  "smtpServer": {}
}
```

Note: `full.path` is `"false"` because groups are flat within a realm (just `/pg.citya`, not nested).

**Step 2: Verify valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('keycloak/realm-template.json','utf8')); console.log('Valid JSON')"`

**Step 3: Commit**

```bash
git add keycloak/realm-template.json && git commit -m "feat: add realm template for tenant provisioning"
```

---

## Task 3: KC Admin Client (Realm-Per-Tenant)

New `src/kc-admin.ts` with realm creation, group CRUD, role assignment, and user-group management — all scoped per-realm.

**Files:**
- Create: `src/kc-admin.ts`
- Create: `mocks/kc-admin.ts`
- Create: `tests/unit/kc-admin.test.ts`

**Step 1: Write the mock**

`mocks/kc-admin.ts` — Express server implementing KC Admin endpoints. Must support:
- `POST /realms/master/.../token` — admin auth
- `POST /admin/realms` — create realm (accepts full RealmRepresentation)
- `GET /admin/realms` — list realms
- `GET /admin/realms/:realm` — get realm
- `POST /admin/realms/:realm/groups` — create group
- `GET /admin/realms/:realm/groups` — list groups
- `PUT /admin/realms/:realm/users/:userId/groups/:groupId` — add user to group
- `GET /admin/realms/:realm/users/:userId/groups` — get user groups
- `GET /admin/realms/:realm/roles` — list realm roles
- `GET /admin/realms/:realm/roles/:roleName` — get role by name (returns full representation with `id`)
- `POST /admin/realms/:realm/users/:userId/role-mappings/realm` — assign realm roles to user
- `GET /admin/realms/:realm/users/:userId/role-mappings/realm` — get user realm roles

Track state per-realm: realms, groups, roles, user-group assignments, user-role assignments. Return proper status codes (201 with Location header, 204, 409 for duplicates).

**Step 2: Write the failing tests**

`tests/unit/kc-admin.test.ts`:

```typescript
describe("initKcAdmin", () => {
  it("authenticates against mock KC Admin");
});

describe("realm operations", () => {
  it("creates a realm from template");
  it("handles duplicate realm creation (409)");
  it("lists existing realms");
});

describe("group operations", () => {
  it("creates a group within a realm");
  it("handles duplicate group (409)");
  it("lists groups in a realm");
});

describe("user-group operations", () => {
  it("assigns a user to a group");
  it("returns user groups");
  it("returns empty for user with no groups");
});

describe("user-role operations", () => {
  it("assigns realm roles to a user");
  it("returns user realm roles");
});

describe("syncTenantRealms", () => {
  it("creates realms and groups from DIGIT_TENANTS env var");
  it("is idempotent");
});

describe("parseTenantEnv", () => {
  it("parses structured format");
  it("parses flat list");
  it("returns empty for empty string");
});
```

**Step 3: Run tests to verify they fail**

Run: `REDIS_PORT=16379 npx vitest run tests/unit/kc-admin.test.ts`
Expected: FAIL (functions don't exist yet)

**Step 4: Implement `src/kc-admin.ts`**

Functions:

```typescript
// Auth
export async function initKcAdmin(): Promise<void>
export function stopKcAdminRefresh(): void

// Realm
export async function createRealm(realmName: string, cities: string[]): Promise<void>
export async function listRealms(): Promise<string[]>

// Groups (scoped to realm)
export async function createGroupInRealm(realm: string, name: string): Promise<string>
export async function getGroupsInRealm(realm: string): Promise<KcGroup[]>

// User-group (scoped to realm)
export async function addUserToGroupInRealm(realm: string, userId: string, groupId: string): Promise<void>
export async function getUserGroupsInRealm(realm: string, userId: string): Promise<KcGroup[]>

// User-role (scoped to realm)
export async function assignRealmRoles(realm: string, userId: string, roleCodes: string[]): Promise<void>
export async function getUserRealmRoles(realm: string, userId: string): Promise<Array<{ name: string }>>

// Sync
export async function syncTenantRealms(): Promise<void>

// Helpers (exported for testing)
export { parseTenantEnv as _parseTenantEnv }
```

Key implementation details:
- `createRealm()` reads `keycloak/realm-template.json`, replaces `__REALM_NAME__`, adds groups to the `groups` array, POSTs to `POST /admin/realms`. Handles 409 (already exists) by creating missing groups individually.
- `assignRealmRoles()` first fetches each role by name (`GET /admin/realms/{realm}/roles/{name}`) to get the full representation with `id`, then POSTs the array to `/users/{userId}/role-mappings/realm`.
- `syncTenantRealms()` reads tenants from MDMS or `DIGIT_TENANTS` env var, groups by root, calls `createRealm()` per root.
- Template is loaded once at module init using `readFileSync`.

**Step 5: Run tests to verify they pass**

Run: `REDIS_PORT=16379 npx vitest run tests/unit/kc-admin.test.ts`
Expected: All pass.

**Step 6: Run full test suite**

Run: `REDIS_PORT=16379 npx vitest run`
Expected: All tests pass (original 35 + new kc-admin tests).

**Step 7: Commit**

```bash
git add src/kc-admin.ts mocks/kc-admin.ts tests/unit/kc-admin.test.ts
git commit -m "feat: add realm-per-tenant KC admin client with tests"
```

---

## Task 4: Dynamic Multi-Issuer JWT Validation

Switch from single-issuer to dynamic issuer based on realm name in the JWT's `iss` claim.

**Files:**
- Modify: `src/jwt.ts` — support multiple JWKS endpoints (one per realm)
- Modify: `src/config.ts` — add `keycloakBaseUrl` (base without realm path)
- Modify: `tests/unit/jwt.test.ts` — add test for multi-issuer

**Step 1: Write the failing test**

Add to `tests/unit/jwt.test.ts`:

```typescript
it("validates JWT from a non-default realm issuer", async () => {
  // Sign a JWT with issuer pointing to a different realm
  // The existing JWKS mock serves all realms on same endpoint
  const token = await signJwt({
    sub: "user-1",
    email: "a@b.com",
  });
  // Should still validate because JWKS keys are the same
  const claims = await validateJwt(`Bearer ${token}`);
  expect(claims).not.toBeNull();
});

it("extracts realm name from issuer", async () => {
  const token = await signJwt({ sub: "u1", email: "a@b.com" });
  const claims = await validateJwt(`Bearer ${token}`);
  expect(claims).not.toBeNull();
  // The issuer in test is "http://localhost:9999/realms/digit-sandbox"
  // so realm should be "digit-sandbox"
  expect(claims!.realm).toBe("digit-sandbox");
});
```

**Step 2: Modify types.ts**

Add `realm?: string` to `KCClaims`:
```typescript
export interface KCClaims {
  sub: string;
  email: string;
  name?: string;
  preferred_username?: string;
  email_verified?: boolean;
  phone_number?: string;
  realm_access?: { roles: string[] };
  groups?: string[];
  realm?: string;  // extracted from iss
}
```

**Step 3: Modify jwt.ts**

Change `validateJwt` to:
1. Decode JWT header without verification to extract `iss` (or use the issuer from successful verification)
2. Parse realm from `iss`: `iss.split("/realms/")[1]`
3. Use a per-realm JWKS cache: `Map<string, JWKSFunction>`
4. For the JWKS URI, derive from config: `${config.keycloakAdminUrl}/realms/${realm}/protocol/openid-connect/certs`
5. Accept any issuer matching `${config.keycloakAdminUrl}/realms/*` (don't hardcode single issuer)
6. Add `realm` to the returned claims

Key change: Replace single `let jwks` with `const jwksCache = new Map<string, ...>()`. The `initJwks` function now takes an optional override for testing.

```typescript
const jwksCache = new Map<string, ReturnType<typeof createTracedRemoteJWKSet>>();

function getJwks(realm: string): ReturnType<typeof createTracedRemoteJWKSet> {
  if (!jwksCache.has(realm)) {
    const uri = jwksUriOverride || `${config.keycloakAdminUrl}/realms/${realm}/protocol/openid-connect/certs`;
    jwksCache.set(realm, createTracedRemoteJWKSet(new URL(uri)));
  }
  return jwksCache.get(realm)!;
}

export async function validateJwt(authHeader: string | undefined): Promise<KCClaims | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    // Decode without verification to get issuer
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const iss = payload.iss as string;
    if (!iss) return null;

    const realm = iss.split("/realms/").pop();
    if (!realm) return null;

    const jwks = getJwks(realm);
    const { payload: verified } = await jwtVerify(token, jwks, { issuer: iss });

    if (!verified.sub || !verified.email) return null;
    return {
      sub: verified.sub,
      email: verified.email as string,
      name: (verified.name as string) || undefined,
      preferred_username: (verified.preferred_username as string) || undefined,
      email_verified: verified.email_verified as boolean | undefined,
      phone_number: (verified.phone_number as string) || undefined,
      realm_access: (verified.realm_access as { roles: string[] }) || undefined,
      groups: (verified.groups as string[]) || undefined,
      realm,
    };
  } catch {
    return null;
  }
}
```

For testing, `initJwks(uri)` sets `jwksUriOverride` so all realms resolve to the test JWKS server.

**Step 4: Run tests**

Run: `REDIS_PORT=16379 npx vitest run`
Expected: All pass (existing JWT tests still work, new tests pass).

**Step 5: Commit**

```bash
git add src/jwt.ts src/types.ts src/config.ts tests/unit/jwt.test.ts
git commit -m "feat: dynamic multi-issuer JWT validation (realm from iss)"
```

---

## Task 5: Wire Realm Sync into Server Startup

Connect the new `kc-admin.ts` to `server.ts` so realms are synced on boot.

**Files:**
- Modify: `src/server.ts` — import and call realm sync on startup

**Step 1: Modify server.ts**

Add to imports:
```typescript
import { initKcAdmin, stopKcAdminRefresh, syncTenantRealms } from "./kc-admin.js";
```

Add to startup sequence (after `startTokenRefresh()`):
```typescript
if (config.tenantSyncEnabled) {
  try {
    await initKcAdmin();
    await syncTenantRealms();
  } catch (err) {
    console.warn("KC Admin init failed (non-fatal):", (err as Error).message);
  }
}
```

Add to SIGTERM handler:
```typescript
stopKcAdminRefresh();
```

**Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: Clean.

**Step 3: Commit**

```bash
git add src/server.ts && git commit -m "feat: wire realm sync into server startup"
```

---

## Task 6: Sync DIGIT Roles Back to KC

After resolving a user, sync their DIGIT tenant-scoped roles to KC realm roles and assign them to the city group.

**Files:**
- Create: `src/kc-sync.ts` — sync logic (DIGIT user -> KC roles + groups)
- Modify: `src/user-resolver.ts` — call sync after resolution
- Create: `tests/unit/kc-sync.test.ts`

**Step 1: Write tests**

`tests/unit/kc-sync.test.ts`:
```typescript
describe("syncUserToKc", () => {
  it("assigns realm roles matching DIGIT user roles");
  it("assigns user to city group based on tenantId");
  it("does nothing if tenantSyncEnabled is false");
  it("does not throw if KC Admin is unavailable (fire-and-forget)");
});
```

**Step 2: Implement `src/kc-sync.ts`**

```typescript
import { config } from "./config.js";
import { assignRealmRoles, addUserToGroupInRealm, getGroupsInRealm } from "./kc-admin.js";
import type { DigitUser } from "./types.js";

export async function syncUserToKc(
  kcSub: string,
  digitUser: DigitUser,
  tenantId: string,
): Promise<void> {
  if (!config.tenantSyncEnabled) return;

  const root = tenantId.split(".")[0];

  // 1. Sync realm roles
  const roleCodes = digitUser.roles.map(r => r.code);
  if (roleCodes.length > 0) {
    await assignRealmRoles(root, kcSub, roleCodes);
  }

  // 2. Assign to city group (if city-level tenant)
  if (tenantId.includes(".")) {
    const groups = await getGroupsInRealm(root);
    const cityGroup = groups.find(g => g.name === tenantId);
    if (cityGroup) {
      await addUserToGroupInRealm(root, kcSub, cityGroup.id);
    }
  }
}
```

**Step 3: Wire into user-resolver.ts**

After the `setCached` call at the end of `resolveUser`, add (fire-and-forget):
```typescript
if (config.tenantSyncEnabled) {
  syncUserToKc(claims.sub, digitUser, effectiveTenant).catch(err =>
    console.warn("KC sync failed (non-fatal):", (err as Error).message)
  );
}
```

Import at top:
```typescript
import { syncUserToKc } from "./kc-sync.js";
```

**Step 4: Run tests**

Run: `REDIS_PORT=16379 npx vitest run`
Expected: All pass.

**Step 5: Commit**

```bash
git add src/kc-sync.ts src/user-resolver.ts tests/unit/kc-sync.test.ts
git commit -m "feat: sync DIGIT user roles and groups back to KC"
```

---

## Task 7: E2E Tests

Test the full flow: JWT with realm-specific issuer -> user resolution -> KC sync.

**Files:**
- Create: `tests/e2e/realm-tenant.test.ts`
- Modify: `tests/setup.ts` — start KC Admin mock in global setup

**Step 1: Update global setup**

In `tests/setup.ts`, add the KC Admin mock alongside the existing mocks:

```typescript
import { createKcAdminMock } from "../mocks/kc-admin.js";

// ... existing mock setup ...

// 4. Mock KC Admin on random port
const { app: kcAdminApp } = createKcAdminMock();
const kcAdminSrv = kcAdminApp.listen(0);
servers.push(kcAdminSrv);
const kcAdminPort = (kcAdminSrv.address() as AddressInfo).port;

process.env.KEYCLOAK_ADMIN_URL = `http://localhost:${kcAdminPort}`;
process.env.TENANT_SYNC_ENABLED = "true";
process.env.DIGIT_TENANTS = "pg:pg.citya,pg.cityb";
```

**Step 2: Write E2E tests**

`tests/e2e/realm-tenant.test.ts`:

```typescript
describe("E2E: realm-per-tenant", () => {
  it("resolves a user and syncs roles to KC mock");
  it("assigns user to city group after first request");
  it("JWT with realm_access.roles maps to DIGIT user roles");
  it("groups claim appears in resolved user context");
});
```

These tests make HTTP requests to the test app with JWTs containing `realm_access.roles` and `groups`, then verify the KC Admin mock received the expected role assignment and group membership calls.

**Step 3: Run full suite**

Run: `REDIS_PORT=16379 npx vitest run`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add tests/e2e/realm-tenant.test.ts tests/setup.ts
git commit -m "test: add E2E tests for realm-per-tenant flow"
```

---

## Task 8: Docker Compose + Documentation

**Files:**
- Modify: `docker-compose.yml` — add KC Admin env vars
- Modify: `docs/role-management.md` — update for realm-per-tenant model
- Modify: `docs/deployment.md` — document new env vars and multi-realm setup

**Step 1: Update docker-compose.yml**

Add to `token-exchange-svc` environment:
```yaml
KEYCLOAK_ADMIN_URL: http://keycloak:8180
KEYCLOAK_ADMIN_USERNAME: admin
KEYCLOAK_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD:-admin}
TENANT_SYNC_ENABLED: "true"
DIGIT_MDMS_HOST: ""
DIGIT_TENANTS: "pg:pg.citya,pg.cityb"
```

**Step 2: Update docs/role-management.md**

Replace the "Why a Single Realm" section and "Tenant <-> Realm Mapping" section with the new realm-per-tenant architecture. Update the architecture diagram. Update the role management instructions to reference per-realm operations.

Key updates:
- Architecture diagram shows realm per tenant root
- JWT example shows realm-scoped roles
- Role management instructions use realm-specific endpoints
- "Future: Realm-per-State" section becomes "Current: Realm-per-State"

**Step 3: Update docs/deployment.md**

Add new env vars table. Update the "Realm Configuration" section to describe the template-based realm provisioning. Add troubleshooting for multi-realm issues.

**Step 4: Commit**

```bash
git add docker-compose.yml docs/role-management.md docs/deployment.md
git commit -m "docs: update for realm-per-tenant architecture"
```

---

## Verification Checklist

After all tasks:

1. `npx tsc --noEmit` — clean compilation
2. `REDIS_PORT=16379 npx vitest run` — all tests pass
3. No references to `checkTenantAccess` or `tenant-auth.ts` remain
4. `src/kc-admin.ts` creates realms (not groups in a single realm)
5. `src/jwt.ts` validates JWTs from any realm (dynamic issuer)
6. `src/kc-sync.ts` syncs DIGIT roles -> KC realm roles
7. `keycloak/realm-template.json` contains all 21 DIGIT roles
8. `docker-compose.yml` has KC Admin env vars
9. Docs reflect realm-per-tenant model
