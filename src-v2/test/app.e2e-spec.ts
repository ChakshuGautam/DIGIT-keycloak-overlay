import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "../app.module";
import { CacheService } from "../cache/cache.service";
import { DigitClientService } from "../user/digit-client.service";
import { KcAdminService } from "../keycloak/kc-admin.service";
import { JwtService } from "../auth/jwt.service";

// ---------------------------------------------------------------------------
// Mock providers — avoid Redis, Keycloak, and DIGIT connections
// ---------------------------------------------------------------------------

const mockCache = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  deleteAllForSub: vi.fn().mockResolvedValue(0),
  ping: vi.fn().mockResolvedValue(true),
  isRedisHealthy: vi.fn().mockReturnValue(true),
  isStale: vi.fn().mockReturnValue(false),
  onModuleInit: vi.fn().mockResolvedValue(undefined),
  onModuleDestroy: vi.fn().mockResolvedValue(undefined),
};

const mockDigitClient = {
  searchUser: vi.fn().mockResolvedValue(null),
  createUser: vi.fn().mockResolvedValue({
    uuid: "test-uuid",
    userName: "test@example.com",
    name: "Test User",
    emailId: "test@example.com",
    mobileNumber: "9000012345",
    tenantId: "pg",
    type: "CITIZEN",
    roles: [{ code: "CITIZEN", name: "Citizen" }],
    active: true,
  }),
  getUserToken: vi.fn().mockResolvedValue({
    token: "mock-digit-token",
    expiresIn: 3600000,
  }),
  updateUserPassword: vi.fn().mockResolvedValue(undefined),
  updateUserRoles: vi.fn().mockResolvedValue(undefined),
  hasSystemToken: vi.fn().mockReturnValue(true),
  generateRandomPassword: vi.fn().mockReturnValue("KcTestPass@1"),
  generateMobileNumber: vi.fn().mockReturnValue("9000012345"),
  generateV1Password: vi.fn().mockReturnValue("Kcabc123@1"),
  getSystemPassword: vi.fn().mockReturnValue("eGov@123"),
  namespacedUserName: vi.fn().mockImplementation((realm: string, email: string) => `${realm}:${email}`),
  resolveUserType: vi.fn().mockReturnValue("CITIZEN"),
  onModuleInit: vi.fn().mockResolvedValue(undefined),
};

const mockJwtService = {
  validate: vi.fn().mockResolvedValue(null),
  extractSubFromToken: vi.fn().mockReturnValue(null),
};

const mockKcAdmin = {
  hasAdminToken: vi.fn().mockReturnValue(false),
  getAdminToken: vi.fn().mockReturnValue(""),
  initWithRetry: vi.fn().mockResolvedValue(undefined),
  syncTenantRealms: vi.fn().mockResolvedValue(undefined),
  createRealm: vi.fn().mockResolvedValue(undefined),
  listRealms: vi.fn().mockResolvedValue([]),
  createGroupInRealm: vi.fn().mockResolvedValue("group-id"),
  getGroupsInRealm: vi.fn().mockResolvedValue([]),
  addUserToGroupInRealm: vi.fn().mockResolvedValue(undefined),
  getUserGroupsInRealm: vi.fn().mockResolvedValue([]),
  assignRealmRoles: vi.fn().mockResolvedValue(undefined),
  getUserRealmRoles: vi.fn().mockResolvedValue([]),
  parseTenantConfig: vi.fn().mockReturnValue(new Map()),
  onModuleInit: vi.fn().mockResolvedValue(undefined),
  onModuleDestroy: vi.fn(),
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

describe("App E2E", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // Set env vars so config validation passes with test defaults
    process.env.NODE_ENV = "test";
    process.env.TENANT_SYNC_ENABLED = "false";

    // Import ConfigModule separately to ensure ConfigService is available
    const { ConfigModule, ConfigService } = await import("@nestjs/config");

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        AppModule,
      ],
    })
      .overrideProvider(CacheService)
      .useValue(mockCache)
      .overrideProvider(DigitClientService)
      .useValue(mockDigitClient)
      .overrideProvider(KcAdminService)
      .useValue(mockKcAdmin)
      .overrideProvider(JwtService)
      .useValue(mockJwtService)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // 1. Health — GET /healthz
  // -----------------------------------------------------------------------
  it("GET /healthz returns 200 with status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("redis");
  });

  // -----------------------------------------------------------------------
  // 2. Readiness — GET /readyz
  // -----------------------------------------------------------------------
  it("GET /readyz returns 200 when cache is healthy", async () => {
    mockCache.ping.mockResolvedValueOnce(true);
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.redis).toBe("connected");
    expect(body).toHaveProperty("circuits");
  });

  it("GET /readyz returns 503 when cache is unhealthy", async () => {
    mockCache.ping.mockResolvedValueOnce(false);
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("degraded");
  });

  // -----------------------------------------------------------------------
  // 3. Metrics — GET /metrics
  // -----------------------------------------------------------------------
  it("GET /metrics returns Prometheus format text containing tes_http_requests_total", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    // Prometheus metrics contain HELP and TYPE lines
    expect(res.body).toContain("# HELP");
    expect(res.body).toContain("# TYPE");
    // Must include the custom app metric
    expect(res.body).toContain("tes_http_requests_total");
  });

  // -----------------------------------------------------------------------
  // 4. Login validation — POST /auth/login
  // -----------------------------------------------------------------------
  it("POST /auth/login with missing fields returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "test@example.com" }, // missing password
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("email and password are required");
  });

  it("POST /auth/login with empty body returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
  });

  // -----------------------------------------------------------------------
  // 5. CORS headers present on responses
  // -----------------------------------------------------------------------
  it("OPTIONS request returns CORS headers with 204", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/some-api-path",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeDefined();
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
  });

  it("CORS wildcard origin when no CORS_ALLOWED_ORIGINS set", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/test-cors",
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  // -----------------------------------------------------------------------
  // 6. Wildcard proxy forwards to gateway when no JWT
  // -----------------------------------------------------------------------
  it("GET on unknown path without JWT attempts gateway forward", async () => {
    // The proxy will try to fetch from the gateway which is not running,
    // so it should return 502 (Bad gateway) since no upstream is available
    const res = await app.inject({
      method: "GET",
      url: "/pgr-services/v2/_search",
    });
    // Without a real gateway, we expect a 502 or the proxy error shape
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe("Bad gateway");
  });

  // -----------------------------------------------------------------------
  // 7. Debug status — GET /debug/status
  // -----------------------------------------------------------------------
  it("GET /debug/status returns internal state", async () => {
    const res = await app.inject({ method: "GET", url: "/debug/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("redis");
    expect(body).toHaveProperty("circuits");
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("memory");
    expect(body.memory).toHaveProperty("rss");
    expect(body.memory).toHaveProperty("heapUsed");
  });

  // -----------------------------------------------------------------------
  // 8. Register validation — POST /auth/register
  // -----------------------------------------------------------------------
  it("POST /auth/register with missing fields returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "a@b.com", password: "Pass@1" }, // missing name
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("email, password, and name are required");
  });

  // -----------------------------------------------------------------------
  // 9. Check-email validation — GET /auth/check-email
  // -----------------------------------------------------------------------
  it("GET /auth/check-email without email param returns 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/check-email",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("email query parameter is required");
  });
});
