import { z } from "zod";

export const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  DIGIT_USER_HOST: z.string().default("http://localhost:8107"),
  DIGIT_SYSTEM_USERNAME: z.string().default("ADMIN"),
  DIGIT_SYSTEM_PASSWORD: z.string().default("eGov@123"),
  DIGIT_SYSTEM_USER_TYPE: z.string().default("EMPLOYEE"),
  DIGIT_SYSTEM_TENANT: z.string().default("pg"),
  DIGIT_DEFAULT_TENANT: z.string().default("pg.citya"),
  DIGIT_GATEWAY_HOST: z.string().default("http://gateway:8080"),
  DIGIT_TENANTS: z.string().default(""),

  KEYCLOAK_INTERNAL_URL: z.string().default("http://localhost:8180"),
  KEYCLOAK_AUDIENCE: z.string().default("digit-ui"),
  KEYCLOAK_ADMIN_URL: z.string().default("http://localhost:8180"),
  KEYCLOAK_ADMIN_REALM: z.string().default("master"),
  KEYCLOAK_ADMIN_CLIENT_ID: z.string().default("admin-cli"),
  KEYCLOAK_ADMIN_USERNAME: z.string().default("admin"),
  KEYCLOAK_ADMIN_PASSWORD: z.string().default("admin"),
  KEYCLOAK_USER_REALM: z.string().default("digit-sandbox"),
  KEYCLOAK_BFF_CLIENT_ID: z.string().default("digit-svc"),
  KEYCLOAK_BFF_CLIENT_SECRET: z.string().default(""),
  TENANT_SYNC_ENABLED: z.coerce.boolean().default(true),

  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().default(6379),
  CACHE_PREFIX: z.string().default("keycloak"),
  CACHE_TTL_SECONDS: z.coerce.number().default(3600),

  CORS_ALLOWED_ORIGINS: z.string().default(""),
  UPSTREAM_SERVICES: z.string().default(""),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
  OTEL_SERVICE_NAME: z.string().default("token-exchange-svc"),
});

export type AppConfig = z.infer<typeof configSchema>;

export function validateConfig(raw: Record<string, unknown>): AppConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Config validation failed:\n${errors.join("\n")}`);
  }

  if (result.data.NODE_ENV === "production") {
    if (result.data.KEYCLOAK_ADMIN_PASSWORD === "admin") {
      throw new Error("KEYCLOAK_ADMIN_PASSWORD must not be 'admin' in production");
    }
    if (result.data.DIGIT_SYSTEM_PASSWORD === "eGov@123") {
      throw new Error("DIGIT_SYSTEM_PASSWORD must not be default in production");
    }
    if (!result.data.CORS_ALLOWED_ORIGINS) {
      throw new Error("CORS_ALLOWED_ORIGINS must be set in production");
    }
  }

  return result.data;
}
