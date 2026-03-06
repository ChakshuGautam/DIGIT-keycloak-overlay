# Role Management

How DIGIT roles flow from Keycloak to the DIGIT platform.

## Architecture

```
Keycloak                    token-exchange-svc              DIGIT
┌─────────────────┐         ┌──────────────────┐           ┌─────────────┐
│ Realm Roles:    │         │ extractDigitRoles │           │ egov-user   │
│  - SUPERUSER    │  JWT    │                  │  _create   │             │
│  - EMPLOYEE     │ ──────> │ realm_access.roles│ ───────> │ user.roles  │
│  - GRO          │         │   ∩ DIGIT_ROLES  │  _update   │             │
│  - PGR_LME      │         │   = DIGIT roles  │           │             │
│  - ...          │         └──────────────────┘           └─────────────┘
│                 │
│ Composite Roles:│         On every request:
│  digit-admin    │         1. Validate JWT
│   = SUPERUSER   │         2. Extract realm_access.roles
│   + EMPLOYEE    │         3. Filter to known DIGIT roles
│   + GRO         │         4. Compare with cached roles
│   + PGR_LME     │         5. Sync if changed
│   + DGRO        │
│   + CSR         │
└─────────────────┘
```

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

## Cache Behavior

- Roles are cached in Redis with 7-day TTL (key: `keycloak:{sub}:{tenantId}`)
- Role changes in Keycloak take effect on the next API call (not instant — requires a new JWT)
- To force immediate re-sync: clear the Redis cache key for the user
- Role comparison is set-based: additions and removals are both detected
