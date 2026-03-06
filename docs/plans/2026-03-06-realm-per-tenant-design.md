# Realm-Per-Tenant Keycloak Architecture

## Problem

DIGIT has a hierarchical tenant model (`pg` -> `pg.citya`, `pg.cityb`) with
tenant-scoped roles (`GRO` tagged to `tenantId: "pg"`). Keycloak currently uses
a single `digit-sandbox` realm with no awareness of this hierarchy. Any
authenticated user can access any tenant -- tenant authorization is enforced only
by DIGIT's backend, not at the KC/proxy layer.

We want KC to mirror DIGIT's tenant hierarchy so that:
- JWTs carry tenant-scoped roles and city assignments natively
- KC admin console shows the tenant structure
- KC can iteratively become the source of truth for tenant/role management

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tenant root mapping | KC Realm per root | Realm = natural isolation boundary, roles scoped by construction |
| City mapping | KC Groups within realm | Hierarchical, visible in admin console |
| Role scoping | All 21 DIGIT roles as realm roles | Simpler than client-per-service, roles naturally scoped to realm |
| Cross-tenant users | Separate accounts per realm | Matches DIGIT model, simplest KC-wise |
| Client-per-service | Not now | All roles as realm roles, client scoping is future refinement |
| Provisioning trigger | Auto on startup sync | token-exchange-svc reads DIGIT tenants and creates realms |
| Existing Tasks 1-4 code | Start fresh | Clean break from single-realm group-based approach |
| Tenant authorization | DIGIT handles it | No 403 enforcement at proxy, DIGIT backend checks role tenantId |

## Data Model Mapping

```
DIGIT                          Keycloak
-----                          --------
Tenant root "pg"          ->   Realm "pg"
  City "pg.citya"         ->     Group "/pg.citya"
  City "pg.cityb"         ->     Group "/pg.cityb"

Tenant root "mz"          ->   Realm "mz"
  City "mz.chimoio"       ->     Group "/mz.chimoio"

DIGIT Role "GRO"          ->   Realm Role "GRO" (in each realm)
DIGIT Role "CITIZEN"      ->   Realm Role "CITIZEN" (in each realm)
... all 21 DIGIT roles    ->   ... as realm roles per realm

User with roles on "pg"   ->   User in realm "pg" with those realm roles
User's city assignment     ->   User's group membership within realm
```

## JWT Shape

A GRO officer in Punjab assigned to City A:

```json
{
  "iss": "https://keycloak.example.com/realms/pg",
  "sub": "a1b2c3d4-...",
  "email": "rajesh@example.com",
  "name": "Rajesh Kumar",
  "realm_access": {
    "roles": ["GRO", "CITIZEN", "EMPLOYEE"]
  },
  "groups": ["/pg.citya"]
}
```

Derivations for token-exchange-svc:
- Tenant root: parse realm name from `iss` -> `pg`
- City: `groups[0]` -> `pg.citya`
- Roles for this tenant: `realm_access.roles` (scoped to realm by construction)

A citizen who filed complaints in two cities:

```json
{
  "iss": ".../realms/pg",
  "realm_access": { "roles": ["CITIZEN"] },
  "groups": ["/pg.citya", "/pg.cityb"]
}
```

A state-level admin (no specific city):

```json
{
  "iss": ".../realms/pg",
  "realm_access": { "roles": ["SUPERUSER", "EMPLOYEE", "CITIZEN"] },
  "groups": []
}
```

## Startup Sync Flow

On boot, token-exchange-svc:

1. Authenticates to KC Admin (master realm, `admin-cli` credentials)
2. Fetches DIGIT tenant list (from MDMS or `DIGIT_TENANTS` env var)
3. For each tenant root, creates a KC realm using a **realm template** JSON:
   - All 21 DIGIT realm roles
   - A public OIDC client (`digit-ui`) with PKCE
   - A `groups` client scope with group membership mapper
   - Google IdP config (if configured via env vars)
4. For each city tenant, creates a group within its root realm
5. Idempotent -- skips existing realms/groups (handles 409)

The realm template is checked into the repo as `keycloak/realm-template.json`.
It contains no tenant-specific data -- the sync function substitutes the realm
name and groups per tenant.

## User Provisioning Flow

Per-request through token-exchange-svc:

1. JWT arrives -- extract realm name from `iss` to determine tenant root
2. Validate JWT against that realm's JWKS endpoint (dynamic issuer)
3. Resolve user in DIGIT (existing flow: cache check, search, lazy provision)
4. Fire-and-forget sync back to KC:
   - Extract tenant-scoped roles from DIGIT user's `roles[]` array
   - Assign matching KC realm roles to the user
   - Assign user to city group based on request's tenantId

## Changes from Current Architecture

| Current (single realm) | New (realm per tenant) |
|------------------------|------------------------|
| Single realm `digit-sandbox` | Realm per tenant root (`pg`, `mz`, ...) |
| `realm-export.json` defines one realm | `realm-template.json` is a template |
| One JWKS endpoint | JWKS per realm (dynamic from `iss`) |
| `kc-admin.ts` manages groups in one realm | Manages realms, groups, roles, users |
| `config.keycloakIssuer` = single URL | Dynamic issuer resolution |
| Groups for tenant hierarchy | Realms for roots, groups for cities |

## What We Don't Build

- No `checkTenantAccess` / 403 enforcement at proxy (DIGIT handles this)
- No client-per-service role scoping (future refinement)
- No cross-realm identity linking (separate accounts per realm)
- No DIGIT->KC response interception for role changes (future work)
- No realm cloning API (use JSON template approach)
