# Role Management

Bidirectional role sync between Keycloak and DIGIT.

## Architecture

```
                       Bidirectional Role Sync
                       =======================

  ┌──────────────────┐                              ┌──────────────────┐
  │    Keycloak       │                              │      DIGIT       │
  │                  │       token-exchange-svc       │                  │
  │ Realm Roles:     │      ┌──────────────────┐     │ egov-user        │
  │  - SUPERUSER     │ JWT  │                  │     │  user.roles      │
  │  - EMPLOYEE      │ ───> │ KC→DIGIT sync    │ ──> │                  │
  │  - GRO           │      │ (on every login) │     │                  │
  │  - PGR_LME       │      │                  │     │                  │
  │  - ...           │ <─── │ DIGIT→KC sync    │ <── │ egov-hrms        │
  │                  │      │ (on role-change  │     │  role assignments │
  │ Composite Roles: │      │  API calls)      │     │                  │
  │  digit-admin     │      └──────────────────┘     │                  │
  └──────────────────┘                              └──────────────────┘

  Source of truth: DIGIT (roles are defined in DIGIT MDMS/access-control)
  Keycloak mirror: kept in sync so JWTs carry current roles
```

### Sync Directions

| Direction | Trigger | Mechanism |
|-----------|---------|-----------|
| **KC → DIGIT** | Every API request | token-exchange-svc reads `realm_access.roles` from JWT, syncs to DIGIT user |
| **DIGIT → KC** | Role-change API calls (`/egov-hrms`, `/user`) | token-exchange-svc intercepts response, mirrors role changes to KC Admin API |

## Sequence Diagrams

### Flow 1: KC → DIGIT (Login-time sync — current)

```
  Browser         Kong        token-exchange-svc     Keycloak       egov-user
    │               │                │                  │               │
    │ POST /kc/pgr-services/...     │                  │               │
    │ Authorization: Bearer <JWT>    │                  │               │
    │──────────────>│                │                  │               │
    │               │───────────────>│                  │               │
    │               │                │                  │               │
    │               │                │ GET /realms/.../certs            │
    │               │                │─────────────────>│               │
    │               │                │<─────────────────│               │
    │               │                │                  │               │
    │               │                │ Validate JWT                     │
    │               │                │ Extract realm_access.roles       │
    │               │                │ Filter to DIGIT_ROLES set        │
    │               │                │                  │               │
    │               │                │ Compare with cached roles        │
    │               │                │                  │               │
    │               │                │  [if roles changed]              │
    │               │                │ POST /user/_updatenovalidate     │
    │               │                │─────────────────────────────────>│
    │               │                │<─────────────────────────────────│
    │               │                │ Update Redis cache               │
    │               │                │                  │               │
    │               │                │ Proxy to upstream DIGIT service  │
    │               │                │─────────────────────────────────>│
    │               │                │                  │               │
```

### Flow 2: DIGIT → KC (Admin assigns role via DIGIT API — proposed)

When an admin uses the DIGIT HRMS API to create/update an employee (which
assigns roles), token-exchange-svc intercepts the response and mirrors the
role change to Keycloak.

```
  Admin UI        Kong        token-exchange-svc     egov-hrms      Keycloak
    │               │                │                  │               │
    │ POST /kc/egov-hrms/employees/_create             │               │
    │ { roles: [EMPLOYEE, GRO] }     │                  │               │
    │──────────────>│                │                  │               │
    │               │───────────────>│                  │               │
    │               │                │                  │               │
    │               │                │ Validate JWT + resolve user      │
    │               │                │                  │               │
    │               │                │ Proxy to egov-hrms               │
    │               │                │─────────────────>│               │
    │               │                │<─────────────────│               │
    │               │                │ 200 OK (employee created)        │
    │               │                │                  │               │
    │               │                │ Detect role-change endpoint      │
    │               │                │ Extract roles from response      │
    │               │                │                  │               │
    │               │                │ POST /admin/realms/.../users/{id}/role-mappings/realm
    │               │                │─────────────────────────────────>│
    │               │                │<─────────────────────────────────│
    │               │                │ 204 (roles assigned in KC)       │
    │               │                │                  │               │
    │               │                │ Update Redis cache               │
    │               │                │                  │               │
    │<──────────────│<───────────────│ 200 OK           │               │
    │               │                │                  │               │
```

### Flow 3: Role definition sync (new role created in DIGIT — proposed)

When a new role is defined in DIGIT's access-control MDMS, it should also
be created as a Keycloak realm role.

```
  Admin           Kong        token-exchange-svc     MDMS/AccessCtrl  Keycloak
    │               │                │                  │               │
    │ POST /kc/access/v1/roles/_create                 │               │
    │ { code: "INSPECTOR", name: "Inspector" }         │               │
    │──────────────>│                │                  │               │
    │               │───────────────>│                  │               │
    │               │                │                  │               │
    │               │                │ Proxy to DIGIT                   │
    │               │                │─────────────────>│               │
    │               │                │<─────────────────│               │
    │               │                │ 200 OK (role created)            │
    │               │                │                  │               │
    │               │                │ Detect role-creation endpoint    │
    │               │                │ Extract role code from response  │
    │               │                │                  │               │
    │               │                │ POST /admin/realms/.../roles     │
    │               │                │ { name: "INSPECTOR" }            │
    │               │                │─────────────────────────────────>│
    │               │                │<─────────────────────────────────│
    │               │                │ 201 (role created in KC)         │
    │               │                │                  │               │
    │               │                │ Add to DIGIT_ROLES set           │
    │               │                │                  │               │
    │<──────────────│<───────────────│ 200 OK           │               │
```

## Intercepted Endpoints (DIGIT → KC sync)

token-exchange-svc watches these upstream responses and mirrors role
changes to Keycloak:

| DIGIT Endpoint | Trigger | KC Action |
|----------------|---------|-----------|
| `POST /egov-hrms/employees/_create` | Employee created with roles | Assign roles to KC user |
| `POST /egov-hrms/employees/_update` | Employee roles changed | Sync roles to KC user |
| `POST /user/users/_updatenovalidate` | User roles updated | Sync roles to KC user |
| `POST /access/v1/roles/_create` | New role defined | Create realm role in KC |

The sync is **fire-and-forget** — if the KC Admin API call fails, the DIGIT
operation still succeeds. KC will catch up on the next login via the
KC → DIGIT sync path. DIGIT is always the source of truth.

## Role Lifecycle

### New User (First Login)

1. User authenticates with Keycloak (password or Google SSO)
2. JWT includes `realm_access.roles` (e.g., `["digit-admin", "SUPERUSER", "EMPLOYEE", "GRO", "PGR_LME", "DGRO", "CSR", "default-roles-digit-sandbox"]`)
3. token-exchange-svc filters to known DIGIT roles: `["SUPERUSER", "EMPLOYEE", "GRO", "PGR_LME", "DGRO", "CSR"]`
4. Creates DIGIT user with these roles + CITIZEN (always added)
5. Caches user in Redis

### Returning User (Roles Unchanged)

1. JWT roles match cached roles
2. No DIGIT API call needed — served from cache
3. Request proxied immediately

### Returning User (Roles Changed in Keycloak)

1. Admin adds/removes roles in Keycloak admin console
2. Next login: JWT has updated `realm_access.roles`
3. token-exchange-svc detects difference from cached roles
4. Calls `_updatenovalidate` to sync DIGIT user roles
5. Updates cache

### Returning User (Roles Changed via DIGIT API)

1. Admin assigns roles via HRMS or user API
2. token-exchange-svc intercepts the response, mirrors to Keycloak
3. Next JWT issued by Keycloak includes the new roles
4. Both systems stay in sync

### User with No Keycloak Roles

If `realm_access` is absent or empty, the user gets only `CITIZEN` (the default).

## DIGIT Role Reference

| Role | Description | Use Case |
|------|-------------|----------|
| `CITIZEN` | Default role for all users | Filing complaints, viewing status |
| `EMPLOYEE` | Base employee role | Required for any staff function |
| `SUPERUSER` | Full system access | Admin operations |
| `GRO` | Grievance Routing Officer | Assign/reject PGR complaints |
| `PGR_LME` | Last Mile Employee | Resolve PGR complaints in the field |
| `DGRO` | Department GRO | Department-level complaint routing |
| `CSR` | Customer Service Rep | File complaints on behalf of citizens |
| `SUPERVISOR` | Supervisor role | Oversight and escalation |
| `AUTO_ESCALATE` | System role | Automatic complaint escalation |
| `PGR_VIEWER` | Read-only PGR access | View complaints without action |
| `TICKET_REPORT_VIEWER` | Report viewer | Access PGR analytics/reports |
| `LOC_ADMIN` | Localization admin | Manage UI translations |
| `MDMS_ADMIN` | Master data admin | Manage MDMS records |
| `HRMS_ADMIN` | HR admin | Manage employees |
| `WORKFLOW_ADMIN` | Workflow admin | Configure workflow state machines |
| `COMMON_EMPLOYEE` | Common employee | Shared employee capabilities |
| `REINDEXING_ROLE` | System role | Elasticsearch reindexing |
| `QA_AUTOMATION` | Test role | Automated testing |
| `SYSTEM` | Internal system role | Service-to-service calls |
| `ANONYMOUS` | Unauthenticated access | Public endpoints |
| `INTERNAL_MICROSERVICE_ROLE` | Internal service role | Inter-service communication |

## Composite Roles

### `digit-admin`

A convenience role that bundles the key admin/employee roles:

| Member Role | Purpose |
|-------------|---------|
| `SUPERUSER` | Full system access |
| `EMPLOYEE` | Base employee role |
| `GRO` | Complaint routing |
| `PGR_LME` | Complaint resolution |
| `DGRO` | Department routing |
| `CSR` | Citizen service |

Assigning `digit-admin` to a user gives them all 6 roles at once.

## How to Manage Roles

### Via Keycloak Admin Console

1. Open https://api.egov.theflywheel.in/auth/admin/
2. Switch to **digit-sandbox** realm
3. **Users** > search for user > **Role mapping** tab
4. Click **Assign role** > filter realm roles > select roles > **Assign**

### Via Keycloak Admin API

```bash
# Get admin token
KC_TOKEN=$(curl -s -X POST \
  'https://api.egov.theflywheel.in/auth/realms/master/protocol/openid-connect/token' \
  -d 'client_id=admin-cli&grant_type=password&username=admin&password=admin' \
  | jq -r .access_token)

KC_URL="https://api.egov.theflywheel.in/auth/admin/realms/digit-sandbox"

# Find user by email
USER_ID=$(curl -s "$KC_URL/users?email=user@example.com" \
  -H "Authorization: Bearer $KC_TOKEN" | jq -r '.[0].id')

# Assign a single role
ROLE=$(curl -s "$KC_URL/roles/GRO" -H "Authorization: Bearer $KC_TOKEN")
curl -X POST "$KC_URL/users/$USER_ID/role-mappings/realm" \
  -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" \
  -d "[$ROLE]"

# Assign digit-admin composite
ROLE=$(curl -s "$KC_URL/roles/digit-admin" -H "Authorization: Bearer $KC_TOKEN")
curl -X POST "$KC_URL/users/$USER_ID/role-mappings/realm" \
  -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" \
  -d "[$ROLE]"

# View user's effective roles
curl -s "$KC_URL/users/$USER_ID/role-mappings/realm/composite" \
  -H "Authorization: Bearer $KC_TOKEN" | jq '.[].name'

# Remove a role
ROLE=$(curl -s "$KC_URL/roles/GRO" -H "Authorization: Bearer $KC_TOKEN")
curl -X DELETE "$KC_URL/users/$USER_ID/role-mappings/realm" \
  -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" \
  -d "[$ROLE]"
```

### Auto-Assignment via IdP Mapper

Currently configured: all Google SSO users get `digit-admin` via the `auto-digit-admin` IdP mapper.

To change which role is auto-assigned:

```bash
# List current mappers
curl -s "$KC_URL/identity-provider/instances/google/mappers" \
  -H "Authorization: Bearer $KC_TOKEN" | jq .

# Delete existing mapper
MAPPER_ID=$(curl -s "$KC_URL/identity-provider/instances/google/mappers" \
  -H "Authorization: Bearer $KC_TOKEN" | jq -r '.[0].id')
curl -X DELETE "$KC_URL/identity-provider/instances/google/mappers/$MAPPER_ID" \
  -H "Authorization: Bearer $KC_TOKEN"

# Create new mapper with different role
curl -X POST "$KC_URL/identity-provider/instances/google/mappers" \
  -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "auto-employee",
    "identityProviderMapper": "oidc-hardcoded-role-idp-mapper",
    "identityProviderAlias": "google",
    "config": { "syncMode": "INHERIT", "role": "EMPLOYEE" }
  }'
```

## Filtering Logic

The token-exchange-svc only maps roles it recognizes. Unknown Keycloak roles (like `default-roles-digit-sandbox`, `offline_access`, `uma_authorization`) are silently ignored.

The filtering happens in `src/user-resolver.ts`:

```typescript
const DIGIT_ROLES = new Set([
  "CITIZEN", "EMPLOYEE", "SUPERUSER", "GRO", "PGR_LME", "DGRO", "CSR",
  // ... all 21 known DIGIT roles
]);

function extractDigitRoles(claims: KCClaims) {
  const kcRoles = claims.realm_access?.roles || [];
  return kcRoles
    .filter(r => DIGIT_ROLES.has(r))
    .map(r => ({ code: r, name: r }));
}
```

CITIZEN is always ensured regardless of what Keycloak reports.

## Tenant ↔ Realm Mapping

### DIGIT Tenant Hierarchy

DIGIT uses a hierarchical multi-tenant model:

```
State root (e.g. "pg")
├── pg.citya
├── pg.cityb
└── pg.cityc

State root (e.g. "mz")
├── mz.maputo
└── mz.chimoio
```

- **State root**: Top-level tenant (e.g. `pg`, `mz`, `ke`). Owns MDMS schemas,
  workflow definitions, and role configs.
- **City tenants**: `{root}.{city}` (e.g. `pg.citya`). Inherit from state root.
  Contain boundaries, employees, complaints.
- **Roles are scoped to the state root**: When a user has `GRO` on `pg`, they can
  act as GRO on any `pg.*` city tenant. The role object carries
  `tenantId: "pg"` regardless of which city the user operates in.

### Keycloak Realm Model

Keycloak uses **realms** as the top-level isolation boundary. Each realm has its
own users, roles, identity providers, and clients.

**Current setup: single realm `digit-sandbox`.**

```
Keycloak
└── digit-sandbox (realm)
    ├── Realm Roles: SUPERUSER, EMPLOYEE, GRO, PGR_LME, ...
    ├── Composite Roles: digit-admin
    ├── Identity Providers: google
    ├── Clients: digit-sandbox-ui
    └── Users: all users across all tenants
```

### Why a Single Realm

| Approach | Pros | Cons |
|----------|------|------|
| **Single realm** (current) | Simple, one user pool, one IdP config, roles map 1:1 | No KC-level tenant isolation |
| **Realm per state root** | KC-native isolation between states | Duplicate IdP config, users can't cross states, complex provisioning |
| **Realm per city** | Maximum isolation | Unmanageable at scale, DIGIT doesn't isolate at city level anyway |

A single realm is the right fit because:

1. **DIGIT handles tenant scoping, not Keycloak.** Keycloak answers "who is this
   user and what can they do?" (authentication + capabilities). DIGIT answers
   "where can they do it?" (tenant-scoped authorization). Duplicating tenant
   isolation in KC would be redundant.

2. **Roles are capability-based, not tenant-scoped.** `GRO` means "can route
   grievances" — the same capability regardless of which state or city. The
   tenant scoping happens when token-exchange-svc tags `tenantId: "pg"` on the
   role object in DIGIT.

3. **Users can exist across tenants.** A DIGIT admin may operate on `pg.citya`
   and `mz.maputo`. With a single realm, they log in once and
   token-exchange-svc resolves the correct tenant from the API request.

### How Tenant Resolution Works

```
  Browser request                      token-exchange-svc            DIGIT
  ─────────────────                    ──────────────────            ─────
  POST /kc/pgr-services/v2/
    request/_search
  Body: { tenantId: "pg.citya" }
          │
          │ JWT has realm_access.roles: [GRO, EMPLOYEE]
          │ (no tenant info in KC — just capabilities)
          ▼
  Extract tenantId from request body ──────────────────>  rootTenant("pg.citya") → "pg"
                                                          │
                                                          ▼
                                                    Create/sync user with roles:
                                                    [{ code: "GRO", tenantId: "pg" },
                                                     { code: "EMPLOYEE", tenantId: "pg" },
                                                     { code: "CITIZEN", tenantId: "pg" }]
```

The `rootTenant()` function in `digit-client.ts` extracts the state root:

```typescript
export function rootTenant(tenantId: string): string {
  return tenantId.split(".")[0];
}
```

Roles are always tagged to the state root, never to a specific city. DIGIT's
access control layer (per-service) handles city-level authorization.

### Multi-State Users

If a user needs to operate across multiple state roots (e.g. `pg` and `mz`),
they need roles tagged to each root in DIGIT. The current implementation caches
per `{sub}:{tenantId}`, so switching between `pg.citya` and `mz.maputo`
triggers separate DIGIT user lookups and role syncs.

**Keycloak roles remain the same** — `GRO` in KC is `GRO` everywhere.
token-exchange-svc maps it to the correct tenant based on the request context.

### Future: Realm-per-State

If DIGIT deployments need stronger isolation between state roots (e.g.
separate Keycloak admin consoles per state, independent IdP configs), the
architecture can evolve to realm-per-state:

```
Keycloak
├── pg (realm) — roles, users, IdP for pg.*
├── mz (realm) — roles, users, IdP for mz.*
└── master (admin realm)
```

This would require:
- token-exchange-svc to map `rootTenant(tenantId)` → KC realm name
- Separate JWKS endpoints per realm (`/realms/{root}/protocol/openid-connect/certs`)
- Separate client registrations per realm
- Users would not cross state boundaries via a single login

This is **not needed now** — the single-realm approach is simpler and sufficient
for the current deployment.

## Cache Behavior

- Roles are cached in Redis with 7-day TTL (key: `keycloak:{sub}:{tenantId}`)
- Role changes in Keycloak take effect on the next API call (not instant — requires a new JWT)
- To force immediate re-sync: clear the Redis cache key for the user
- Role comparison is set-based: additions and removals are both detected
