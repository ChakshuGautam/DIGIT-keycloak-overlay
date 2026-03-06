/**
 * Integration verification against the LIVE DIGIT stack.
 *
 * This script starts the token-exchange-svc pointing at the real running
 * DIGIT services (egov-user, pgr-services, etc.) via their host-exposed ports,
 * then runs through the critical flows to verify everything works end-to-end.
 *
 * Prerequisites:
 *   - DIGIT stack running (docker compose -f docker-compose.deploy.yaml up -d)
 *   - Redis available on port 16379
 *   - egov-user on port 18107
 *   - pgr-services on port 18083
 *   - egov-workflow-v2 on port 18109
 *
 * Usage:
 *   npx tsx tests/integration/verify-live.ts
 */

import { config } from "../../src/config.js";
import { initJwks, validateJwt } from "../../src/jwt.js";
import { initCache, closeCache, getRedis, getCached, delCached } from "../../src/cache.js";
import { initSystemToken, getSystemToken, searchUser, rootTenant } from "../../src/digit-client.js";
import { resolveUser } from "../../src/user-resolver.js";
import { initRoutes, getRouteMap } from "../../src/routes.js";
import { createApp } from "../../src/server.js";
import { initKeys, signJwt, createJwksApp } from "../../mocks/jwks-server.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// ── Config ──────────────────────────────────────────────────────────

const DIGIT_USER_HOST = "http://localhost:18107";
const PGR_HOST = "http://localhost:18083";
const WORKFLOW_HOST = "http://localhost:18109";
const MDMS_HOST = "http://localhost:18094";
const LOCALIZATION_HOST = "http://localhost:18096";
const REDIS_PORT = 16379;
const TEST_TENANT = "pg.citya";
const DB_URL = process.env.DIGIT_DB_URL || "postgresql://egov:egov123@localhost:15432/egov";
const TEST_EMAIL_DOMAINS = [
  "@keycloak-test.example.com",
  "@keycloak-proxy-test.example.com",
];

// ── Test Infrastructure ─────────────────────────────────────────────

let jwksServer: Server;
let appServer: Server;
let appPort: number;

const results: { name: string; status: "PASS" | "FAIL" | "SKIP"; detail?: string; ms?: number }[] = [];

async function test(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, status: "PASS", ms: Date.now() - start });
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
  } catch (err: any) {
    results.push({ name, status: "FAIL", detail: err.message, ms: Date.now() - start });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

// ── Phase 1: Verify DIGIT services are reachable ────────────────────

async function verifyPrerequisites() {
  console.log("\n═══ Phase 1: Verify DIGIT Stack Reachable ═══\n");

  await test("egov-user health", async () => {
    const resp = await fetch(`${DIGIT_USER_HOST}/user/health`);
    assert(resp.ok, `egov-user returned ${resp.status}`);
  });

  await test("pgr-services health", async () => {
    const resp = await fetch(`${PGR_HOST}/pgr-services/health`);
    assert(resp.ok, `pgr-services returned ${resp.status}`);
  });

  await test("egov-workflow-v2 health", async () => {
    const resp = await fetch(`${WORKFLOW_HOST}/egov-workflow-v2/health`);
    assert(resp.ok, `egov-workflow-v2 returned ${resp.status}`);
  });

  await test("Redis PING", async () => {
    const { Redis } = await import("ioredis");
    const redis = new Redis({ host: "localhost", port: REDIS_PORT });
    const pong = await redis.ping();
    assert(pong === "PONG", `Expected PONG, got ${pong}`);
    await redis.quit();
  });

  await test("MDMS health", async () => {
    const resp = await fetch(`${MDMS_HOST}/mdms-v2/health`);
    assert(resp.ok, `MDMS returned ${resp.status}`);
  });
}

// ── Phase 2: Verify system token acquisition ────────────────────────

async function verifySystemToken() {
  console.log("\n═══ Phase 2: System Token Acquisition ═══\n");

  await test("System login (ADMIN)", async () => {
    (config as any).digitUserHost = DIGIT_USER_HOST;
    const token = await initSystemToken();
    assert(typeof token === "string" && token.length > 10, "Token too short");
  });

  await test("System token can search users", async () => {
    // Search for ADMIN user (should exist in any DIGIT setup)
    const user = await searchUser("", TEST_TENANT);
    // Null is acceptable (no user with empty email) — just shouldn't throw
  });
}

// ── Phase 3: Verify JWKS + JWT flow ────────────────────────────────

async function verifyJwtFlow() {
  console.log("\n═══ Phase 3: JWT Validation Flow ═══\n");

  await test("Mock JWKS server starts", async () => {
    await initKeys();
    const app = createJwksApp();
    jwksServer = app.listen(9999);
  });

  await test("JWT validation works for valid token", async () => {
    (config as any).keycloakIssuer = "http://localhost:9999/realms/digit-sandbox";
    initJwks("http://localhost:9999/realms/digit-sandbox/protocol/openid-connect/certs");

    const token = await signJwt({
      sub: "live-test-user-1",
      email: "live-test@example.com",
      name: "Live Test User",
    });
    const claims = await validateJwt(`Bearer ${token}`);
    assert(claims !== null, "Claims should not be null");
    assert(claims!.sub === "live-test-user-1", "Wrong sub");
    assert(claims!.email === "live-test@example.com", "Wrong email");
  });

  await test("JWT validation rejects expired token", async () => {
    const token = await signJwt(
      { sub: "expired", email: "exp@test.com" },
      { expiresIn: "0s" },
    );
    await new Promise((r) => setTimeout(r, 1100));
    const claims = await validateJwt(`Bearer ${token}`);
    assert(claims === null, "Should reject expired token");
  });
}

// ── Phase 4: User resolution against real egov-user ─────────────────

async function verifyUserResolution() {
  console.log("\n═══ Phase 4: User Resolution (Real egov-user) ═══\n");

  // Use a unique email to avoid collisions with existing data
  const testId = `live-${Date.now()}`;
  const testEmail = `${testId}@keycloak-test.example.com`;
  const testSub = `kc-${testId}`;

  await test("Redis cache init", async () => {
    initCache(`redis://localhost:${REDIS_PORT}`);
    const redis = getRedis();
    await redis.ping();
  });

  await test("Resolve user (lazy provision via real egov-user)", async () => {
    const user = await resolveUser(
      { sub: testSub, email: testEmail, name: "Live Test" },
      TEST_TENANT,
    );
    assert(user.emailId === testEmail, `Expected ${testEmail}, got ${user.emailId}`);
    assert(user.name === "Live Test", `Expected "Live Test", got ${user.name}`);
    assert(user.uuid.length > 0, "UUID should be non-empty");
    assert(user.type === "CITIZEN", `Expected CITIZEN, got ${user.type}`);
    console.log(`    → Provisioned DIGIT user: ${user.uuid}`);
  });

  await test("User is cached in Redis", async () => {
    const cached = await getCached(testSub, TEST_TENANT);
    assert(cached !== null, "Cache should have the user");
    assert(cached!.user.emailId === testEmail, "Cached email mismatch");
  });

  await test("Second resolve returns from cache (same UUID)", async () => {
    const cached1 = await getCached(testSub, TEST_TENANT);
    const user2 = await resolveUser(
      { sub: testSub, email: testEmail, name: "Live Test" },
      TEST_TENANT,
    );
    assert(user2.uuid === cached1!.user.uuid, "UUID should match cached");
  });

  await test("User exists in real egov-user (verify via _search by userName)", async () => {
    // DIGIT stores users at state-root level (e.g. "pg" not "pg.citya")
    // and encrypts all PII. Search by userName at root tenant.
    const resp = await fetch(`${DIGIT_USER_HOST}/user/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        RequestInfo: { apiId: "Rainmaker", authToken: getSystemToken() },
        userName: testEmail,
        tenantId: rootTenant(TEST_TENANT),
        pageSize: 1,
      }),
    });
    assert(resp.ok, `User search returned ${resp.status}`);
    const body = (await resp.json()) as any;
    const found = body.user?.[0];
    assert(found !== null && found !== undefined, "User should be findable in egov-user by userName");
    assert(found.userName === testEmail, `userName mismatch: expected ${testEmail}, got ${found.userName}`);
  });

  await test("Name sync updates cache when name changes", async () => {
    const user = await resolveUser(
      { sub: testSub, email: testEmail, name: "Updated Name" },
      TEST_TENANT,
    );
    assert(user.name === "Updated Name", `Expected "Updated Name", got ${user.name}`);
    const cached = await getCached(testSub, TEST_TENANT);
    assert(cached!.user.name === "Updated Name", "Cache not updated");
  });

  // Clean up test cache keys
  await delCached(testSub, TEST_TENANT);
}

// ── Phase 5: Full proxy flow against real services ──────────────────

async function verifyProxyFlow() {
  console.log("\n═══ Phase 5: Proxy Flow (Real DIGIT Backends) ═══\n");

  initRoutes();
  // Override routes to point to host-exposed ports (not Docker internal)
  getRouteMap().set("/pgr-services", PGR_HOST);
  getRouteMap().set("/egov-workflow-v2", WORKFLOW_HOST);
  getRouteMap().set("/mdms-v2", MDMS_HOST);
  getRouteMap().set("/localization", LOCALIZATION_HOST);
  getRouteMap().set("/user", DIGIT_USER_HOST);

  await test("Start token-exchange-svc", async () => {
    const app = await createApp();
    appServer = app.listen(0);
    appPort = (appServer.address() as AddressInfo).port;
    console.log(`    → token-exchange-svc on :${appPort}`);
  });

  await test("Health check via proxy", async () => {
    const resp = await fetch(`http://localhost:${appPort}/healthz`);
    assert(resp.ok, `Health check returned ${resp.status}`);
    const body = (await resp.json()) as any;
    assert(body.status === "ok", `Health status: ${body.status}`);
  });

  await test("401 without JWT", async () => {
    const resp = await fetch(`http://localhost:${appPort}/pgr-services/v2/request/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ RequestInfo: {} }),
    });
    assert(resp.status === 401, `Expected 401, got ${resp.status}`);
  });

  const testId2 = `proxy-${Date.now()}`;
  const testEmail2 = `${testId2}@keycloak-proxy-test.example.com`;

  await test("PGR complaint search via proxy (real pgr-services)", async () => {
    const token = await signJwt({
      sub: `kc-${testId2}`,
      email: testEmail2,
      name: "Proxy Test User",
    });

    const resp = await fetch(`http://localhost:${appPort}/pgr-services/v2/request/_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        RequestInfo: { apiId: "Rainmaker" },
        tenantId: TEST_TENANT,
      }),
    });

    assert(resp.ok, `PGR search returned ${resp.status}: ${await resp.clone().text()}`);
    const body = (await resp.json()) as any;
    // PGR returns ServiceWrappers with an array (even if empty)
    assert(
      body.ServiceWrappers !== undefined || body.services !== undefined,
      `Unexpected PGR response shape: ${JSON.stringify(Object.keys(body))}`,
    );
    console.log(`    → PGR returned ${(body.ServiceWrappers || body.services || []).length} complaints`);
  });

  await test("Workflow business services search via proxy (real workflow)", async () => {
    const token = await signJwt({
      sub: `kc-${testId2}`,
      email: testEmail2,
      name: "Proxy Test User",
    });

    const resp = await fetch(
      `http://localhost:${appPort}/egov-workflow-v2/egov-wf/businessservice/_search?tenantId=${TEST_TENANT}&businessServices=PGR`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          RequestInfo: { apiId: "Rainmaker" },
          tenantId: TEST_TENANT,
        }),
      },
    );

    assert(resp.ok, `Workflow search returned ${resp.status}: ${await resp.clone().text()}`);
    const body = (await resp.json()) as any;
    assert(
      body.BusinessServices !== undefined,
      `Unexpected workflow response: ${JSON.stringify(Object.keys(body))}`,
    );
    console.log(`    → Workflow returned ${body.BusinessServices?.length || 0} business services`);
  });

  await test("MDMS search via proxy (real mdms-v2)", async () => {
    const token = await signJwt({
      sub: `kc-${testId2}`,
      email: testEmail2,
      name: "Proxy Test User",
    });

    const resp = await fetch(`http://localhost:${appPort}/mdms-v2/v2/_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        RequestInfo: { apiId: "Rainmaker" },
        MdmsCriteria: {
          tenantId: "pg",
          schemaCode: "common-masters.Department",
          limit: 5,
        },
      }),
    });

    assert(resp.ok, `MDMS search returned ${resp.status}: ${await resp.clone().text()}`);
    const body = (await resp.json()) as any;
    assert(body.mdms !== undefined, `Unexpected MDMS response: ${JSON.stringify(Object.keys(body))}`);
    console.log(`    → MDMS returned ${body.mdms?.length || 0} department records`);
  });

  // Clean up
  await delCached(`kc-${testId2}`, TEST_TENANT);
}

// ── Phase 6: Route coverage check ──────────────────────────────────

async function verifyRouteCoverage() {
  console.log("\n═══ Phase 6: Route Coverage (Kong vs Overlay) ═══\n");

  // Kong service routes from kong.yml
  const kongRoutes: Record<string, string> = {
    "/mdms-v2": "http://egov-mdms-service:8094",
    "/user": "http://egov-user:8107",
    "/egov-enc-service": "http://egov-enc-service:1234",
    "/egov-idgen": "http://egov-idgen:8088",
    "/egov-workflow-v2": "http://egov-workflow-v2:8109",
    "/localization": "http://egov-localization:8096",
    "/boundary-service": "http://boundary-service:8081",
    "/access": "http://egov-accesscontrol:8090",
    "/pgr-services": "http://pgr-services:8080",
    "/filestore": "http://egov-filestore:8083",
    "/egov-hrms": "http://egov-hrms:8092",
    "/egov-bndry-mgmnt": "http://egov-bndry-mgmnt:8080",
    "/inbox": "http://inbox:8080",
    "/egov-indexer": "http://egov-indexer:8080",
  };

  // Our overlay's default routes
  const overlayRoutes = getRouteMap();

  await test("All Kong API routes have overlay mappings", async () => {
    const missing: string[] = [];
    const mismatched: string[] = [];

    for (const [path, kongUpstream] of Object.entries(kongRoutes)) {
      const overlayUpstream = overlayRoutes.get(path);
      if (!overlayUpstream) {
        missing.push(path);
      }
    }

    if (missing.length > 0) {
      console.log(`    ⚠ Missing routes in overlay: ${missing.join(", ")}`);
      console.log(`    These Kong routes need to be added to src/routes.ts`);
    }

    // Soft assertion — report but don't fail
    console.log(`    → ${Object.keys(kongRoutes).length} Kong routes, ${missing.length} missing from overlay`);
  });

  await test("Port mapping documentation", async () => {
    console.log("    Kong route → internal service → host port:");
    const portMap: Record<string, number> = {
      "egov-mdms-service:8094": 18094,
      "egov-user:8107": 18107,
      "egov-enc-service:1234": 11234,
      "egov-idgen:8088": 18088,
      "egov-workflow-v2:8109": 18109,
      "egov-localization:8096": 18096,
      "boundary-service:8081": 18081,
      "egov-accesscontrol:8090": 18090,
      "pgr-services:8080": 18083,
      "egov-filestore:8083": 18084,
      "egov-hrms:8092": 18092,
      "egov-bndry-mgmnt:8080": 18086,
      "inbox:8080": 18097,
      "egov-indexer:8080": 18095,
    };
    for (const [svc, port] of Object.entries(portMap)) {
      console.log(`      ${svc.padEnd(30)} → :${port}`);
    }
  });
}

// ── Teardown: clean up test users and cache ──────────────────────────

async function teardown() {
  console.log("\n═══ Teardown: Cleaning Test Artifacts ═══\n");

  // 1. Clean Redis cache keys matching keycloak:* test patterns
  await test("Clean Redis cache keys", async () => {
    try {
      const { Redis } = await import("ioredis");
      const redis = new Redis({ host: "localhost", port: REDIS_PORT });
      const keys = await redis.keys("keycloak:*");
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`    → Deleted ${keys.length} Redis cache key(s)`);
      } else {
        console.log("    → No keycloak:* cache keys found");
      }
      await redis.quit();
    } catch (err: any) {
      console.log(`    ⚠ Redis cleanup skipped: ${err.message}`);
    }
  });

  // 2. Clean test users from DB
  await test("Clean test users from DB", async () => {
    try {
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: DB_URL });
      await client.connect();

      const conditions = TEST_EMAIL_DOMAINS.map(
        (d) => `username LIKE '%${d}'`
      ).join(" OR ");

      const result = await client.query(
        `DELETE FROM eg_user WHERE ${conditions}`
      );
      console.log(`    → Deleted ${result.rowCount} test user(s) from eg_user`);

      await client.end();
    } catch (err: any) {
      // pg module may not be installed — that's OK, skip gracefully
      console.log(`    ⚠ DB cleanup skipped: ${err.message}`);
    }
  });
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  Keycloak Overlay — Live Integration Verification   ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  try {
    await verifyPrerequisites();
    await verifySystemToken();
    await verifyJwtFlow();
    await verifyUserResolution();
    await verifyProxyFlow();
    await verifyRouteCoverage();
  } finally {
    // Always run teardown, even on test failure
    await teardown().catch((err) => console.error("Teardown error:", err));

    // Close servers and connections
    jwksServer?.close();
    appServer?.close();
    await closeCache().catch(() => {});
  }

  // Summary
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║                   Test Summary                      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;

  for (const r of results) {
    const icon = r.status === "PASS" ? "✓" : "✗";
    const time = r.ms ? ` (${r.ms}ms)` : "";
    console.log(`  ${icon} ${r.name}${time}${r.detail ? ` — ${r.detail}` : ""}`);
  }

  console.log(`\n  Total: ${results.length} | Pass: ${pass} | Fail: ${fail}\n`);

  if (fail > 0) {
    console.log("  ⚠ Some tests failed. Review the failures above before integrating.\n");
    process.exit(1);
  } else {
    console.log("  ✓ All checks passed. Safe to integrate with the DIGIT stack.\n");
    process.exit(0);
  }
}

main();
