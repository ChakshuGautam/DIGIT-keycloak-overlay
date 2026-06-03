export const config = {
  port: parseInt(process.env.PORT || "3000"),

  // DIGIT egov-user
  digitUserHost: process.env.DIGIT_USER_HOST || "http://localhost:8107",
  digitSystemUsername: process.env.DIGIT_SYSTEM_USERNAME || "ADMIN",
  digitSystemPassword: process.env.DIGIT_SYSTEM_PASSWORD || "eGov@123",
  digitSystemUserType: process.env.DIGIT_SYSTEM_USER_TYPE || "EMPLOYEE",
  digitSystemTenant: process.env.DIGIT_SYSTEM_TENANT || "pg",
  digitDefaultTenant: process.env.DIGIT_DEFAULT_TENANT || "pg.citya",

  // DIGIT gateway
  digitGatewayHost: process.env.DIGIT_GATEWAY_HOST || "http://gateway:8080",

  // Keycloak
  keycloakIssuer: process.env.KEYCLOAK_ISSUER || "http://localhost:8180/auth/realms/digit-sandbox",
  keycloakJwksUri: process.env.KEYCLOAK_JWKS_URI || "http://localhost:8180/auth/realms/digit-sandbox/protocol/openid-connect/certs",

  // Keycloak Admin
  keycloakAdminUrl: process.env.KEYCLOAK_ADMIN_URL || "http://localhost:8180",
  keycloakAdminRealm: process.env.KEYCLOAK_ADMIN_REALM || "master",
  keycloakAdminClientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID || "admin-cli",
  keycloakAdminUsername: process.env.KEYCLOAK_ADMIN_USERNAME || "admin",
  keycloakAdminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD || "admin",
  // HMAC secret used to derive a strong KC-internal password for users provisioned
  // via the DIGIT-fallback path. The derived password lives only in KC (KC's stored
  // hash + the overlay's HMAC) — users never see it, can't log in with it. DIGIT
  // remains the source of truth for credentials (OTP for citizens, real password
  // for employees). Falls back to the admin password so existing deployments don't
  // need new wiring, but operators should set a dedicated secret in production.
  keycloakProvisioningSecret:
    process.env.KEYCLOAK_PROVISIONING_SECRET ||
    process.env.KEYCLOAK_ADMIN_PASSWORD ||
    "overlay-provisioning-default-secret",
  keycloakUserRealm: process.env.KEYCLOAK_USER_REALM || "digit-sandbox",

  // Placeholder mobile prefix for citizens provisioned via SSO who have no
  // phone_number claim in their KC JWT. The overlay synthesizes a 10-digit
  // mobile as `<prefix><5-digit-hash-of-sub>`. Default `90000` produces
  // `90000XXXXX` which fits standard 10-digit (India) regexes. Deployments
  // with different tenant validation regexes must override — e.g. Bomet's
  // Kenya regex `^0?[17][0-9]{8}$` needs prefix `07000` to produce
  // `07000XXXXX` (valid 10-digit Kenya mobile shape). The hash is derived
  // from the user's KC sub, so it stays stable across re-provisioning.
  overlaySyntheticMobilePrefix:
    process.env.OVERLAY_SYNTHETIC_MOBILE_PREFIX || "90000",
  tenantSyncEnabled: process.env.TENANT_SYNC_ENABLED !== "false",

  // DIGIT MDMS (for tenant sync)
  digitMdmsHost: process.env.DIGIT_MDMS_HOST || "",
  digitTenants: process.env.DIGIT_TENANTS || "",

  // Redis
  redisHost: process.env.REDIS_HOST || "localhost",
  redisPort: parseInt(process.env.REDIS_PORT || "6379"),
  cachePrefix: process.env.CACHE_PREFIX || "keycloak",
  cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || "604800"),

  // Upstream routing
  upstreamServices: process.env.UPSTREAM_SERVICES || "",
};
