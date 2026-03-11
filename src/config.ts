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
  keycloakUserRealm: process.env.KEYCLOAK_USER_REALM || "digit-sandbox",
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
