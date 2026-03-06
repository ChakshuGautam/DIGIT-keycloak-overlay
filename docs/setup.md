# Keycloak Setup Guide

Step-by-step guide to set up Keycloak with the DIGIT stack from scratch.

## Prerequisites

- DIGIT stack running via `docker-compose.deploy.yaml` in `tilt-demo/`
- `curl` and `jq` installed
- Access to Keycloak admin console

## Step 1: Verify Keycloak is Running

```bash
# Health check
curl -s https://api.egov.theflywheel.in/auth/health/ready | jq .

# Admin console (browser)
# https://api.egov.theflywheel.in/auth/admin/master/console/
# Credentials: admin / admin
```

## Step 2: Set Up Google SSO

### 2a. Create Google OAuth Credentials

1. Go to [Google Cloud Console - Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **Create Credentials** > **OAuth client ID**
3. Application type: **Web application**
4. Name: `DIGIT Sandbox Keycloak`
5. Authorized redirect URIs:
   ```
   https://api.egov.theflywheel.in/auth/realms/digit-sandbox/broker/google/endpoint
   ```
6. Note the **Client ID** and **Client Secret**

### 2b. Configure Google IdP in Keycloak

1. Open [Keycloak Admin Console](https://api.egov.theflywheel.in/auth/admin/)
2. Switch to **digit-sandbox** realm (top-left dropdown)
3. **Identity providers** > **Add provider** > **Google**
4. Fill in Client ID and Client Secret from step 2a
5. Click **Save**

### 2c. Test Google Login

Open: `https://api.egov.theflywheel.in/auth/realms/digit-sandbox/account/`

Click **Sign in** > **Login with Google**. After login, verify the user appears under **Users** in the admin console.

## Step 3: Create DIGIT Roles in Keycloak

These roles mirror the DIGIT access control system. Run the following script:

```bash
# Get admin token
KC_TOKEN=$(curl -s -X POST \
  'https://api.egov.theflywheel.in/auth/realms/master/protocol/openid-connect/token' \
  -d 'client_id=admin-cli&grant_type=password&username=admin&password=admin' \
  | jq -r .access_token)

KC_URL="https://api.egov.theflywheel.in/auth/admin/realms/digit-sandbox"

# Create all 21 DIGIT roles
ROLES=(
  CITIZEN EMPLOYEE SUPERUSER GRO PGR_LME DGRO CSR SUPERVISOR
  AUTO_ESCALATE PGR_VIEWER TICKET_REPORT_VIEWER LOC_ADMIN MDMS_ADMIN
  HRMS_ADMIN WORKFLOW_ADMIN COMMON_EMPLOYEE REINDEXING_ROLE
  QA_AUTOMATION SYSTEM ANONYMOUS INTERNAL_MICROSERVICE_ROLE
)

for role in "${ROLES[@]}"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$KC_URL/roles" \
    -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$role\",\"description\":\"DIGIT role: $role\"}")
  echo "$role -> $code"  # 201=created, 409=already exists
done
```

## Step 4: Create `digit-admin` Composite Role

This groups the key admin roles so a single assignment grants full access:

```bash
# Create the composite role
curl -s -o /dev/null -w '%{http_code}' -X POST "$KC_URL/roles" \
  -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"digit-admin","description":"Composite: full DIGIT admin access","composite":true}'

# Get role objects for composites
COMPOSITE_ROLES=(SUPERUSER EMPLOYEE GRO PGR_LME DGRO CSR)
ROLE_ARRAY="[]"
for role in "${COMPOSITE_ROLES[@]}"; do
  role_json=$(curl -s "$KC_URL/roles/$role" -H "Authorization: Bearer $KC_TOKEN")
  ROLE_ARRAY=$(echo "$ROLE_ARRAY" | jq --argjson r "$role_json" '. += [$r]')
done

# Add composites
curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$KC_URL/roles/digit-admin/composites" \
  -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" \
  -d "$ROLE_ARRAY"
```

**Verify:** Admin console > Realm roles > `digit-admin` > Associated roles tab should show 6 member roles.

## Step 5: Auto-Admin for Google SSO Users

Create an IdP mapper that automatically assigns `digit-admin` to all users who log in via Google:

```bash
curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$KC_URL/identity-provider/instances/google/mappers" \
  -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "auto-digit-admin",
    "identityProviderMapper": "oidc-hardcoded-role-idp-mapper",
    "identityProviderAlias": "google",
    "config": {
      "syncMode": "INHERIT",
      "role": "digit-admin"
    }
  }'
```

**Important:** This assigns `digit-admin` to **all** Google SSO users. To restrict which domains can use Google SSO, configure authorized domains in the Google OAuth app settings.

### Assigning Roles to Existing Users

Users who logged in before the mapper was created won't have the role. Assign manually:

```bash
# Find user
USER_ID=$(curl -s "$KC_URL/users?email=user@example.com" \
  -H "Authorization: Bearer $KC_TOKEN" | jq -r '.[0].id')

# Get digit-admin role object
ROLE_JSON=$(curl -s "$KC_URL/roles/digit-admin" -H "Authorization: Bearer $KC_TOKEN")

# Assign
curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$KC_URL/users/$USER_ID/role-mappings/realm" \
  -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" \
  -d "[$ROLE_JSON]"
```

## Step 6: Verify Token-Exchange-Svc

```bash
# Health check
curl -s https://api.egov.theflywheel.in/kc/healthz | jq .

# Check logs
cd ~/code/tilt-demo
docker compose -f docker-compose.deploy.yaml logs -f token-exchange-svc
```

## Step 7: Test End-to-End

1. Log in via Google SSO at the Keycloak account page
2. Obtain a JWT token (from the browser's network tab or via OIDC flow)
3. Make an API call through the token-exchange proxy:

```bash
curl -s -X POST https://api.egov.theflywheel.in/kc/pgr-services/v2/request/_search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <keycloak-jwt>" \
  -d '{"RequestInfo":{},"tenantId":"pg.citya"}' | jq .
```

The token-exchange-svc will:
1. Validate the JWT
2. Extract `realm_access.roles` from the JWT
3. Provision/update the DIGIT user with matching roles
4. Proxy the request to pgr-services

## Troubleshooting

### Roles not appearing in JWT

Keycloak includes `realm_access.roles` in access tokens by default. Verify:

```bash
# Decode a JWT (paste token at jwt.io or use jq)
echo "<jwt>" | cut -d. -f2 | base64 -d 2>/dev/null | jq .realm_access
```

### User has CITIZEN only despite having KC roles

Clear the Redis cache to force re-provisioning:

```bash
docker exec digit-redis redis-cli KEYS 'keycloak:*'
docker exec digit-redis redis-cli DEL $(docker exec digit-redis redis-cli KEYS 'keycloak:*' | tr '\n' ' ')
```

The next API call will re-read roles from the JWT and sync them.

### IdP mapper not applying

The mapper runs on login, not retroactively. The user must log out and back in via Google SSO for the mapper to fire. For immediate effect, assign roles manually via the admin console or API (see Step 5).
