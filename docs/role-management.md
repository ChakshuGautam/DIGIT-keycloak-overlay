# Role Management

Bidirectional role sync between Keycloak and DIGIT.

## Architecture

```
                       Bidirectional Role Sync
                       =======================

  ┌──────────────────────────────┐                   ┌──────────────────┐
  │    Keycloak                   │                   │      DIGIT       │
  │                              │  token-exchange-svc│                  │
  │ Realm "pg":                  │  ┌──────────────┐  │ egov-user        │
  │  ├─ Roles: GRO, PGR_LME, …  │  │              │  │  user.roles      │
  │  ├─ Groups: pg.citya, pg.cityb│ │ KC→DIGIT     │  │                  │
  │  └─ Users: alice, bob       │──>│ (every login)│─>│                  │
  │                              │  │              │  │                  │
  │ Realm "mz":                  │<─│ DIGIT→KC     │<─│ egov-hrms        │
  │  ├─ Roles: GRO, PGR_LME, …  │  │ (role change)│  │  role assignments │
  │  ├─ Groups: mz.maputo       │  │              │  │                  │
  │  └─ Users: carlos           │  └──────────────┘  │                  │
  │                              │                   │                  │
  │ Realm "master":              │                   │                  │
  │  └─ Admin only              │                   │                  │
  └──────────────────────────────┘                   └──────────────────┘

  Source of truth: DIGIT (roles are defined in DIGIT MDMS/access-control)
  Keycloak mirror: kept in sync so JWTs carry current roles
  One realm per DIGIT state root — city tenants map to groups within the realm
```

### Sync Directions

| Direction | Trigger | Mechanism |
|-----------|---------|-----------|
| **KC → DIGIT** | Every API request | token-exchange-svc reads `realm_access.roles` from JWT (realm = state root), syncs to DIGIT user |
| **DIGIT → KC** | Role-change API calls (`/egov-hrms`, `/user`) | token-exchange-svc intercepts response, mirrors role changes to the tenant's KC realm via Admin API |

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

1. User authenticates with Keycloak (password or Google SSO) in the realm matching their state root (e.g. `pg`)
2. JWT includes `realm_access.roles` (e.g., `["SUPERUSER", "EMPLOYEE", "GRO", "PGR_LME", "DGRO", "CSR", "default-roles-pg"]`) and `groups` (e.g., `["pg.citya"]`)
3. token-exchange-svc validates the JWT against the realm's JWKS endpoint
4. Filters to known DIGIT roles: `["SUPERUSER", "EMPLOYEE", "GRO", "PGR_LME", "DGRO", "CSR"]`
5. Creates DIGIT user with these roles + CITIZEN (always added), scoped to the state root
6. Syncs user to the KC realm: assigns realm roles and adds to the city group
7. Caches user in Redis

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
2. Switch to the realm matching the state root (e.g. **pg**, **mz**)
3. **Users** > search for user > **Role mapping** tab
4. Click **Assign role** > filter realm roles > select roles > **Assign**

Each state root has its own realm with the same set of DIGIT roles. Users only appear in the realm they belong to.

### Via Keycloak Admin API

```bash
# Get admin token (always authenticate against the master realm)
KC_TOKEN=$(curl -s -X POST \
  'https://api.egov.theflywheel.in/auth/realms/master/protocol/openid-connect/token' \
  -d 'client_id=admin-cli&grant_type=password&username=admin&password=admin' \
  | jq -r .access_token)

# Set the realm for the state root you want to manage
REALM="pg"  # or "mz", "ke", etc.
KC_URL="https://api.egov.theflywheel.in/auth/admin/realms/$REALM"

# Find user by email
USER_ID=$(curl -s "$KC_URL/users?email=user@example.com" \
  -H "Authorization: Bearer $KC_TOKEN" | jq -r '.[0].id')

# Assign a single role
ROLE=$(curl -s "$KC_URL/roles/GRO" -H "Authorization: Bearer $KC_TOKEN")
curl -X POST "$KC_URL/users/$USER_ID/role-mappings/realm" \
  -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" \
  -d "[$ROLE]"

# View user's effective roles
curl -s "$KC_URL/users/$USER_ID/role-mappings/realm/composite" \
  -H "Authorization: Bearer $KC_TOKEN" | jq '.[].name'

# View user's group membership (shows city tenants)
curl -s "$KC_URL/users/$USER_ID/groups" \
  -H "Authorization: Bearer $KC_TOKEN" | jq '.[].name'

# Remove a role
ROLE=$(curl -s "$KC_URL/roles/GRO" -H "Authorization: Bearer $KC_TOKEN")
curl -X DELETE "$KC_URL/users/$USER_ID/role-mappings/realm" \
  -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" \
  -d "[$ROLE]"

# List all realms (one per state root)
curl -s "https://api.egov.theflywheel.in/auth/admin/realms" \
  -H "Authorization: Bearer $KC_TOKEN" | jq '.[].realm'
```

### Auto-Assignment via IdP Mapper

IdP mappers are configured **per realm**. Each realm can have its own identity
providers and auto-role-assignment rules. For example, realm `pg` might auto-assign
`digit-admin` to all Google SSO users, while realm `mz` uses a different provider.

To configure auto-role-assignment for a specific realm:

```bash
REALM="pg"  # the state root realm to configure
KC_URL="https://api.egov.theflywheel.in/auth/admin/realms/$REALM"

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

Note: Identity providers must be set up independently in each realm. The realm
template (`realm-template.json`) ships with an empty `identityProviders` array
-- add providers per-realm via the admin console or API after provisioning.

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

**Current setup: one realm per DIGIT state root.**

```
Keycloak
├── pg (realm)
│   ├── Realm Roles: CITIZEN, EMPLOYEE, SUPERUSER, GRO, PGR_LME, DGRO, CSR, ...
│   ├── Groups: pg.citya, pg.cityb
│   ├── Clients: digit-ui (public OIDC + PKCE)
│   └── Users: users operating on pg.* tenants
│
├── mz (realm)
│   ├── Realm Roles: CITIZEN, EMPLOYEE, SUPERUSER, GRO, PGR_LME, DGRO, CSR, ...
│   ├── Groups: mz.maputo, mz.chimoio
│   ├── Clients: digit-ui
│   └── Users: users operating on mz.* tenants
│
└── master (admin realm — Keycloak internal)
```

### Current: Realm-per-State

Each DIGIT state root maps to exactly one Keycloak realm. City tenants are
represented as **groups** within the realm.

| DIGIT Concept | Keycloak Concept | Example |
|---------------|-----------------|---------|
| State root (`pg`) | Realm (`pg`) | `/realms/pg` |
| City tenant (`pg.citya`) | Group within realm | Group `pg.citya` in realm `pg` |
| DIGIT role (`GRO`) | Realm role (`GRO`) | Same name in every realm |
| User | User (realm-scoped) | Exists in exactly one realm |

**Why realm-per-state:**

1. **KC-native tenant isolation.** Each state has its own user pool, roles,
   sessions, and IdP configuration. A breach or misconfiguration in one state
   realm does not affect others.

2. **Independent IdP configuration.** Different states can use different identity
   providers (e.g. state `pg` uses Google SSO, state `mz` uses Microsoft Entra)
   without sharing client credentials.

3. **Roles are replicated, not shared.** Each realm gets the same set of DIGIT
   roles from `keycloak/realm-template.json`. `GRO` in realm `pg` and `GRO` in
   realm `mz` are independent role objects, but carry the same meaning.

4. **City-level grouping via KC groups.** Groups like `pg.citya` allow
   fine-grained user-to-city mapping within a realm. The `groups` claim in the
   JWT carries the user's city memberships.

### Template-Based Realm Provisioning

Realms are provisioned automatically on startup from `keycloak/realm-template.json`.
The template contains all 21 DIGIT roles, the `digit-ui` client configuration,
a `groups` client scope mapper, and security settings.

The `DIGIT_TENANTS` env var drives provisioning:

```bash
# Format: "root:city1,city2;root2:city3"
DIGIT_TENANTS="pg:pg.citya,pg.cityb;mz:mz.maputo,mz.chimoio"
```

On startup, `syncTenantRealms()` in `kc-admin.ts`:
1. Parses `DIGIT_TENANTS` into a map of `{root → [cities]}`
2. For each root, calls `createRealm(root, cities)`:
   - Renders `realm-template.json` with `__REALM_NAME__` replaced by the root
   - Creates the realm via KC Admin API (`POST /admin/realms`)
   - Creates a group for each city tenant
3. If the realm already exists (409), syncs groups only (adds missing ones)

This is idempotent — running it multiple times is safe.

### How Tenant Resolution Works

```
  Browser request                      token-exchange-svc            DIGIT
  ─────────────────                    ──────────────────            ─────
  POST /kc/pgr-services/v2/
    request/_search
  Body: { tenantId: "pg.citya" }
          │
          │ JWT issued by realm "pg"
          │ realm_access.roles: [GRO, EMPLOYEE]
          │ groups: ["pg.citya"]
          ▼
  Validate JWT against            ──────────────────>  rootTenant("pg.citya") → "pg"
  /realms/pg/.../certs                                  │
                                                        ▼
                                                  Create/sync user with roles:
                                                  [{ code: "GRO", tenantId: "pg" },
                                                   { code: "EMPLOYEE", tenantId: "pg" },
                                                   { code: "CITIZEN", tenantId: "pg" }]
                                                        │
                                                        ▼
                                                  Sync back to KC:
                                                  - assignRealmRoles("pg", sub, roles)
                                                  - addUserToGroup("pg", sub, "pg.citya")
```

The `rootTenant()` function extracts the state root:

```typescript
// tenantId "pg.citya" → realm "pg"
export function rootTenant(tenantId: string): string {
  return tenantId.split(".")[0];
}
```

Roles are always tagged to the state root, never to a specific city. DIGIT's
access control layer (per-service) handles city-level authorization.

### JWT Structure (Realm-Scoped)

A JWT issued by realm `pg` looks like:

```json
{
  "iss": "https://api.egov.theflywheel.in/auth/realms/pg",
  "sub": "a1b2c3d4-...",
  "email": "alice@example.com",
  "realm_access": {
    "roles": ["CITIZEN", "EMPLOYEE", "GRO", "PGR_LME", "default-roles-pg"]
  },
  "groups": ["pg.citya"]
}
```

Key points:
- `iss` identifies the realm (and therefore the state root)
- `realm_access.roles` are scoped to that realm
- `groups` carries city-tenant membership
- Unknown roles (like `default-roles-pg`) are filtered out by token-exchange-svc

### Multi-State Deployments

Users exist in exactly one realm. If a deployment spans multiple states, each
state is a separate realm with separate users, roles, and IdP configs.

A user operating across multiple states would need separate accounts in each
realm. This matches DIGIT's model where roles are scoped to a state root and
cross-state access requires separate role assignments.

The `DIGIT_TENANTS` env var supports multiple state roots:

```bash
DIGIT_TENANTS="pg:pg.citya,pg.cityb;mz:mz.maputo,mz.chimoio"
```

This creates two realms (`pg` and `mz`) with their respective city groups.

## Cache Behavior

- Roles are cached in Redis with 7-day TTL (key: `keycloak:{sub}:{tenantId}`)
- The `sub` is scoped to the KC realm, so users in different realms have different subs
- Role changes in Keycloak take effect on the next API call (not instant -- requires a new JWT)
- To force immediate re-sync: clear the Redis cache key for the user
- Role comparison is set-based: additions and removals are both detected
- When `TENANT_SYNC_ENABLED=true`, role changes are synced back to the user's KC realm (fire-and-forget)
