# Keycloak Deployment & Operations Guide

This guide covers the production deployment of Keycloak with the DIGIT stack, including Google SSO setup, role mapping, and administration.

## Architecture Overview

```
Browser
  │
  │  https://api.egov.theflywheel.in/auth/*
  │  https://api.egov.theflywheel.in/kc/*
  ▼
┌─────────────────────────────────────────────────────────┐
│  Nginx (port 443)                                       │
│  api.egov.theflywheel.in → localhost:18000              │
└──────────────────────┬──────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Kong Gateway (port 18000)                              │
│                                                         │
│  /auth/*  → keycloak:8180         (Keycloak login/admin)│
│  /kc/*    → token-exchange-svc:3000  (JWT→DIGIT proxy)  │
│  /user/*  → egov-user:8107        (existing DIGIT auth) │
│  /pgr-services/* → pgr:8080      (direct DIGIT access)  │
└──────────────────────┬──────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   Keycloak    token-exchange    DIGIT backends
   (port 8180)  -svc (port 3000)  (unchanged)
```

**Two auth paths coexist:**
- **Existing**: `/user/oauth/token` → DIGIT's native auth (used by MCP, DIGIT UI, internal services)
- **New**: `/auth/*` → Keycloak login → `/kc/*` → token-exchange-svc → DIGIT backends

Neither path affects the other. The existing DIGIT auth is fully preserved.

## Endpoints

| URL | Purpose |
|-----|---------|
| `https://api.egov.theflywheel.in/auth/admin/` | Keycloak admin console |
| `https://api.egov.theflywheel.in/auth/realms/digit-sandbox/account/` | User self-service portal |
| `https://api.egov.theflywheel.in/auth/realms/digit-sandbox/.well-known/openid-configuration` | OIDC discovery |
| `https://api.egov.theflywheel.in/kc/healthz` | Token-exchange-svc health |
| `https://api.egov.theflywheel.in/kc/<digit-path>` | JWT-protected DIGIT API proxy |

**Admin credentials**: `admin` / `admin` (change in production via `KEYCLOAK_ADMIN_PASSWORD` env var)

## Docker Compose Services

Three new services in `tilt-demo/docker-compose.deploy.yaml`:

### keycloak-db-init
One-shot container that creates the `keycloak` database in PostgreSQL. Idempotent — safe to run multiple times. Connects directly to `postgres-db:5432` (not pgbouncer, because DDL statements can't run through transaction-mode pgbouncer).

### keycloak
Keycloak 24.0 running in dev mode with realm auto-import. On first boot, imports `keycloak/realm-export.json` which creates the `digit-sandbox` realm.

Key environment variables:
| Variable | Value | Purpose |
|----------|-------|---------|
| `KC_HOSTNAME_URL` | `https://api.egov.theflywheel.in/auth` | Sets issuer URL in JWTs |
| `KC_HOSTNAME_ADMIN_URL` | `https://api.egov.theflywheel.in/auth` | Sets admin console URLs |
| `KC_HTTP_RELATIVE_PATH` | `/auth` | All endpoints served under /auth/* |
| `KC_PROXY_HEADERS` | `xforwarded` | Trust X-Forwarded-* from Kong/nginx |
| `KC_DB_URL` | `jdbc:postgresql://postgres-db:5432/keycloak` | Direct DB (not pgbouncer) |
| `KEYCLOAK_ADMIN_PASSWORD` | `admin` (override via env) | Admin password |

### token-exchange-svc
Node.js service that validates Keycloak JWTs and proxies requests to DIGIT backends with injected system auth.

Key environment variables:
| Variable | Value | Purpose |
|----------|-------|---------|
| `KEYCLOAK_ISSUER` | `https://api.egov.theflywheel.in/auth/realms/digit-sandbox` | Must match JWT `iss` claim |
| `KEYCLOAK_JWKS_URI` | `http://keycloak:8180/auth/realms/...` | Internal URL for fetching signing keys |
| `DIGIT_USER_HOST` | `http://egov-user:8107` | DIGIT user service |
| `DIGIT_SYSTEM_USERNAME` | `ADMIN` | System account for forwarding requests |
| `REDIS_HOST` | `redis` | Cache for resolved users |

## Startup Order

```
postgres-db (healthy)
├── keycloak-db-init (runs CREATE DATABASE, exits)
│   └── keycloak (starts, imports realm, ~30-45s to healthy)
├── pgbouncer → egov-user (healthy)
└── redis (healthy)
    └── token-exchange-svc (needs keycloak + redis + egov-user)
```

Kong doesn't depend on the Keycloak services — it handles 502s gracefully until they're ready.

## Setting Up Google SSO

### Step 1: Create Google OAuth Credentials

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `DIGIT Sandbox Keycloak`
5. Authorized redirect URIs — add:
   ```
   https://api.egov.theflywheel.in/auth/realms/digit-sandbox/broker/google/endpoint
   ```
6. Click **Create** and note the **Client ID** and **Client Secret**

### Step 2: Configure in Keycloak

1. Open [Keycloak Admin Console](https://api.egov.theflywheel.in/auth/admin/)
2. Select realm **digit-sandbox** (dropdown in sidebar)
3. Go to **Identity providers** → **Add provider** → **Google**
4. Fill in:
   - **Client ID**: from Google Cloud Console
   - **Client Secret**: from Google Cloud Console
   - Leave other defaults (scopes: `openid email profile`)
5. Click **Save**

The Keycloak login page will now show a **"Login with Google"** button.

### Step 3: Test

1. Open: `https://api.egov.theflywheel.in/auth/realms/digit-sandbox/account/`
2. Click **Sign in** → you should see the Google SSO option
3. After Google login, the user appears in Keycloak under **Users**

### Other SSO Providers

The same process works for GitHub, Microsoft, Apple, or any OIDC/SAML provider:
- **Identity providers** → **Add provider** → choose provider
- Each provider needs its own OAuth app and redirect URI:
  ```
  https://api.egov.theflywheel.in/auth/realms/digit-sandbox/broker/<provider-id>/endpoint
  ```

## Role Mapping

Roles exist at two levels:

### Keycloak Roles (Identity Layer)

Keycloak roles answer: **"Who is this person?"**

**Create a realm role:**
1. Admin console → **Realm roles** → **Create role**
2. Name: e.g., `grievance-officer`, `admin`, `field-worker`
3. Save

**Assign to a user:**
1. **Users** → select user → **Role mapping** tab
2. Click **Assign role** → filter by realm roles → select → **Assign**

**Auto-assign via Identity Provider Mapper** (e.g., all Google SSO users get a role):
1. **Identity providers** → **Google** → **Mappers** tab → **Add mapper**
2. Mapper type: **Hardcoded Role**
3. Role: select the role to auto-assign
4. This applies to all users who log in via that provider

**Auto-assign based on email domain** (e.g., `@yourdomain.com` → `admin`):
1. **Identity providers** → **Google** → **Mappers** tab → **Add mapper**
2. Mapper type: **Attribute Importer** (import email)
3. Then create a **Client scope** with a **Script mapper** or use **Authentication → Flows** to conditionally assign roles

### DIGIT Roles (Application Layer)

DIGIT roles answer: **"What can this person do in DIGIT?"**

Examples: `CITIZEN`, `EMPLOYEE`, `GRO` (Grievance Routing Officer), `PGR_LME` (Last Mile Employee)

**Current behavior:**
- The token-exchange-svc auto-provisions all Keycloak users as DIGIT `CITIZEN` users
- DIGIT roles like `GRO`, `PGR_LME`, `EMPLOYEE` must be assigned separately via HRMS

**Manual DIGIT role assignment:**
- Use the MCP tools: `employee_create` or `user_role_add`
- Or via DIGIT Admin UI → HRMS → Employee Management

### Keycloak → DIGIT Role Mapping (Not Yet Implemented)

A future enhancement to the token-exchange-svc could read `realm_access.roles` from the JWT and automatically assign corresponding DIGIT roles:

```
Keycloak role          → DIGIT role
─────────────────────────────────────
grievance-officer      → GRO, EMPLOYEE
field-worker           → PGR_LME, EMPLOYEE
admin                  → SUPERUSER, EMPLOYEE
(default)              → CITIZEN
```

This would be implemented in `src/user-resolver.ts` during the lazy provisioning step. The mapping would be configurable via environment variables.

## Realm Configuration

The `digit-sandbox` realm is configured in `keycloak/realm-export.json`:

| Setting | Value | Notes |
|---------|-------|-------|
| Registration | Enabled | Users can self-register |
| Login with email | Enabled | Email is the primary identifier |
| Email verification | Disabled | Sandbox — no email verification needed |
| Password policy | `length(8)` | Minimum 8 characters |
| Access token lifespan | 15 minutes | Short-lived for security |
| SSO session idle | 30 minutes | Session expires after inactivity |
| SSO session max | 7 days | Maximum session duration |
| Brute force protection | Enabled | 5 failures → 60s lockout |
| PKCE | Required (S256) | For the `digit-sandbox-ui` client |

### Client: digit-sandbox-ui

A public OIDC client for browser-based apps:
- **Client ID**: `digit-sandbox-ui`
- **Flow**: Authorization Code + PKCE (no client secret)
- **Redirect URIs**: `http://localhost:*`, `https://*.egov.theflywheel.in/*`
- **Web Origins**: `http://localhost:3000`, `http://localhost:5173`, `https://*.egov.theflywheel.in`

## Operations

### Check Health

```bash
# Keycloak
curl https://api.egov.theflywheel.in/auth/health/ready

# Token-exchange-svc
curl https://api.egov.theflywheel.in/kc/healthz

# Existing DIGIT auth (should still work)
curl -X POST https://api.egov.theflywheel.in/user/oauth/token \
  -H "Authorization: Basic ZWdvdi11c2VyLWNsaWVudDo=" \
  -d "grant_type=password&username=ADMIN&password=eGov%40123&tenantId=pg&scope=read&userType=EMPLOYEE"
```

### View Logs

```bash
cd ~/code/tilt-demo

# Keycloak logs
docker compose -f docker-compose.deploy.yaml logs -f keycloak

# Token-exchange-svc logs
docker compose -f docker-compose.deploy.yaml logs -f token-exchange-svc
```

### Restart Services

```bash
cd ~/code/tilt-demo

# Restart just Keycloak (token-exchange-svc auto-reconnects)
docker compose -f docker-compose.deploy.yaml restart keycloak

# Restart token-exchange-svc
docker compose -f docker-compose.deploy.yaml restart token-exchange-svc

# Restart both (and reload Kong routes)
docker compose -f docker-compose.deploy.yaml restart keycloak token-exchange-svc kong
```

### Update Realm Configuration

To modify the realm after initial import:
1. Make changes in the Keycloak admin console
2. Export: **Realm settings** → **Action** → **Partial export** (include clients, roles)
3. Save the export to `keycloak/realm-export.json`
4. Commit to git

Note: `--import-realm` only imports on **first boot** (empty database). To re-import after changes, either:
- Delete the keycloak database: `docker exec docker-postgres psql -U egov -c "DROP DATABASE keycloak"`
- Or make changes directly in the admin console (they persist in the database)

### Run Integration Tests

```bash
cd /root/DIGIT-keycloak-overlay

# Unit tests (requires Redis on port 16379)
REDIS_PORT=16379 npm test

# Live integration tests (requires full DIGIT stack running)
npx tsx tests/integration/verify-live.ts

# Manual cleanup of test artifacts
npx tsx tests/integration/cleanup.ts
```

## Kong Routes

Two routes added to `kong/kong.yml`:

```yaml
# Keycloak — passthrough, strip_path: false
# /auth/realms/digit-sandbox/... → keycloak:8180/auth/realms/digit-sandbox/...
- name: keycloak-service
  url: http://keycloak:8180
  routes:
    - paths: [/auth]
      strip_path: false

# Token exchange — strip /kc prefix before forwarding
# /kc/pgr-services/v2/request/_search → token-exchange-svc:3000/pgr-services/v2/request/_search
- name: token-exchange-service
  url: http://token-exchange-svc:3000
  routes:
    - paths: [/kc]
      strip_path: true
```

## Port Reference

| Service | Internal Port | Host Port | External URL |
|---------|--------------|-----------|--------------|
| Keycloak | 8180 | 18180 | `https://api.egov.theflywheel.in/auth/` |
| token-exchange-svc | 3000 | 18200 | `https://api.egov.theflywheel.in/kc/` |
| Kong | 8000 | 18000 | `https://api.egov.theflywheel.in/` |
| egov-user | 8107 | 18107 | `https://api.egov.theflywheel.in/user/` |

## Troubleshooting

### JWT issuer mismatch (401 from token-exchange-svc)

The `KEYCLOAK_ISSUER` env var on token-exchange-svc must exactly match the `iss` claim in JWTs issued by Keycloak. Verify:

```bash
# Check what Keycloak reports as its issuer
curl -s https://api.egov.theflywheel.in/auth/realms/digit-sandbox/.well-known/openid-configuration | jq .issuer

# Check what token-exchange-svc expects
docker inspect digit-token-exchange --format '{{range .Config.Env}}{{println .}}{{end}}' | grep KEYCLOAK_ISSUER
```

These must match. If they don't, update `KEYCLOAK_ISSUER` in docker-compose and restart.

### Keycloak admin console redirects to wrong port

If the admin console redirects to `localhost:8000` or another wrong URL, check that `KC_HOSTNAME_ADMIN_URL` is set:

```yaml
KC_HOSTNAME_URL: https://api.egov.theflywheel.in/auth
KC_HOSTNAME_ADMIN_URL: https://api.egov.theflywheel.in/auth
```

Both are needed — `KC_HOSTNAME_URL` controls realm/token URLs, `KC_HOSTNAME_ADMIN_URL` controls admin console URLs.

### Keycloak not starting (database issues)

Keycloak connects directly to `postgres-db:5432` (not pgbouncer). If the `keycloak` database doesn't exist:

```bash
# Check if keycloak DB exists
docker exec docker-postgres psql -U egov -lqt | grep keycloak

# Manually create if needed
docker exec docker-postgres psql -U egov -c "CREATE DATABASE keycloak OWNER egov;"

# Restart keycloak
docker compose -f docker-compose.deploy.yaml restart keycloak
```

### Redis cache stale after changes

If user resolution returns stale data after changing Keycloak user attributes:

```bash
# Clear all keycloak cache keys
docker exec digit-redis redis-cli KEYS 'keycloak:*'
docker exec digit-redis redis-cli DEL $(docker exec digit-redis redis-cli KEYS 'keycloak:*' | tr '\n' ' ')
```

Or run the cleanup script:
```bash
cd /root/DIGIT-keycloak-overlay && npx tsx tests/integration/cleanup.ts
```
