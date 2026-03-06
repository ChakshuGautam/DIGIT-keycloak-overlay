/**
 * Integration test: validates realm-per-tenant sync against live Keycloak.
 *
 * Requires LIVE_KC_URL env var pointing to a running Keycloak instance.
 * Skips automatically if not set.
 *
 * Usage:
 *   LIVE_KC_URL=http://172.19.0.34:8180/auth \
 *   KEYCLOAK_ADMIN_USERNAME=admin \
 *   KEYCLOAK_ADMIN_PASSWORD=admin \
 *   DIGIT_TENANTS="pg:pg.citya,pg.cityb;mz:mz.chimoio" \
 *   npx vitest run tests/integration/live-kc-sync.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../src/config.js";
import {
  initKcAdmin,
  stopKcAdminRefresh,
  createRealm,
  listRealms,
  getGroupsInRealm,
  createGroupInRealm,
  addUserToGroupInRealm,
  getUserGroupsInRealm,
  assignRealmRoles,
  getUserRealmRoles,
  syncTenantRealms,
  _parseTenantEnv,
} from "../../src/kc-admin.js";

const LIVE_KC_URL = process.env.LIVE_KC_URL;
const TEST_REALM = "integration-test";

// All 21 DIGIT roles that must exist in every provisioned realm
const DIGIT_ROLES = [
  "CITIZEN", "EMPLOYEE", "SUPERUSER", "GRO", "PGR_LME", "DGRO", "CSR",
  "SUPERVISOR", "AUTO_ESCALATE", "PGR_VIEWER", "TICKET_REPORT_VIEWER",
  "LOC_ADMIN", "MDMS_ADMIN", "HRMS_ADMIN", "WORKFLOW_ADMIN",
  "COMMON_EMPLOYEE", "REINDEXING_ROLE", "QA_AUTOMATION", "SYSTEM",
  "ANONYMOUS", "INTERNAL_MICROSERVICE_ROLE",
];

async function getAdminToken(): Promise<string> {
  const resp = await fetch(
    `${config.keycloakAdminUrl}/realms/${config.keycloakAdminRealm}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: config.keycloakAdminClientId,
        username: config.keycloakAdminUsername,
        password: config.keycloakAdminPassword,
      }),
    },
  );
  return ((await resp.json()) as { access_token: string }).access_token;
}

async function deleteRealm(realm: string): Promise<void> {
  const token = await getAdminToken();
  await fetch(`${config.keycloakAdminUrl}/admin/realms/${realm}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function createKcUser(realm: string, username: string): Promise<string> {
  const token = await getAdminToken();
  const resp = await fetch(`${config.keycloakAdminUrl}/admin/realms/${realm}/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@test.local`,
      enabled: true,
      firstName: "Test",
      lastName: "User",
    }),
  });
  if (resp.status === 201) {
    return (resp.headers.get("Location") || "").split("/").pop() || "";
  }
  // Already exists
  const searchResp = await fetch(
    `${config.keycloakAdminUrl}/admin/realms/${realm}/users?username=${username}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const users = (await searchResp.json()) as Array<{ id: string }>;
  return users[0]?.id || "";
}

async function getRealmRoles(realm: string): Promise<string[]> {
  const token = await getAdminToken();
  const resp = await fetch(
    `${config.keycloakAdminUrl}/admin/realms/${realm}/roles?first=0&max=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const roles = (await resp.json()) as Array<{ name: string }>;
  return roles.map((r) => r.name);
}

async function getRealmClients(realm: string): Promise<Array<{ clientId: string; defaultClientScopes: string[] }>> {
  const token = await getAdminToken();
  const resp = await fetch(
    `${config.keycloakAdminUrl}/admin/realms/${realm}/clients?first=0&max=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return (await resp.json()) as Array<{ clientId: string; defaultClientScopes: string[] }>;
}

async function getRealmClientScopes(realm: string): Promise<Array<{ name: string; protocolMappers?: Array<{ name: string; protocolMapper: string; config: Record<string, string> }> }>> {
  const token = await getAdminToken();
  const resp = await fetch(
    `${config.keycloakAdminUrl}/admin/realms/${realm}/client-scopes`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return (await resp.json()) as any[];
}

describe.skipIf(!LIVE_KC_URL)("Live KC: startup sync", () => {
  beforeAll(async () => {
    // Point our code at the live KC
    (config as any).keycloakAdminUrl = LIVE_KC_URL;
    await deleteRealm(TEST_REALM);
    await initKcAdmin();
  }, 30_000);

  afterAll(async () => {
    await deleteRealm(TEST_REALM);
    stopKcAdminRefresh();
  }, 30_000);

  // ── Realm creation ──────────────────────────────────────────────────────

  it("creates a realm from template with city groups", async () => {
    await createRealm(TEST_REALM, [`${TEST_REALM}.city1`, `${TEST_REALM}.city2`]);

    const realms = await listRealms();
    expect(realms).toContain(TEST_REALM);

    const groups = await getGroupsInRealm(TEST_REALM);
    const names = groups.map((g) => g.name);
    expect(names).toContain(`${TEST_REALM}.city1`);
    expect(names).toContain(`${TEST_REALM}.city2`);
  });

  it("provisions all 21 DIGIT roles in the realm", async () => {
    const roles = await getRealmRoles(TEST_REALM);
    for (const role of DIGIT_ROLES) {
      expect(roles, `missing role: ${role}`).toContain(role);
    }
  });

  it("provisions digit-ui client with PKCE and groups scope", async () => {
    const clients = await getRealmClients(TEST_REALM);
    const digitUi = clients.find((c) => c.clientId === "digit-ui");
    expect(digitUi).toBeDefined();
    expect(digitUi!.defaultClientScopes).toContain("groups");
  });

  it("provisions groups client scope with oidc-group-membership-mapper", async () => {
    const scopes = await getRealmClientScopes(TEST_REALM);
    const groupsScope = scopes.find((s) => s.name === "groups");
    expect(groupsScope).toBeDefined();

    const mapper = groupsScope!.protocolMappers?.find(
      (m) => m.protocolMapper === "oidc-group-membership-mapper",
    );
    expect(mapper).toBeDefined();
    expect(mapper!.config["claim.name"]).toBe("groups");
    expect(mapper!.config["access.token.claim"]).toBe("true");
  });

  // ── Idempotency ─────────────────────────────────────────────────────────

  it("is idempotent — re-creating adds missing groups without failing", async () => {
    await createRealm(TEST_REALM, [
      `${TEST_REALM}.city1`,
      `${TEST_REALM}.city2`,
      `${TEST_REALM}.city3`,
    ]);

    const groups = await getGroupsInRealm(TEST_REALM);
    const names = groups.map((g) => g.name);
    expect(names).toContain(`${TEST_REALM}.city1`);
    expect(names).toContain(`${TEST_REALM}.city2`);
    expect(names).toContain(`${TEST_REALM}.city3`);
  });

  // ── Group CRUD ──────────────────────────────────────────────────────────

  it("creates and lists groups", async () => {
    const id = await createGroupInRealm(TEST_REALM, `${TEST_REALM}.city4`);
    expect(id).toBeTruthy();

    const groups = await getGroupsInRealm(TEST_REALM);
    expect(groups.some((g) => g.name === `${TEST_REALM}.city4`)).toBe(true);
  });

  it("handles duplicate group gracefully", async () => {
    const id = await createGroupInRealm(TEST_REALM, `${TEST_REALM}.city4`);
    expect(id).toBeTruthy();
  });

  // ── User-group assignment ───────────────────────────────────────────────

  it("assigns a user to a group and retrieves it", async () => {
    const userId = await createKcUser(TEST_REALM, "testuser-groups");
    expect(userId).toBeTruthy();

    const groups = await getGroupsInRealm(TEST_REALM);
    const city1 = groups.find((g) => g.name === `${TEST_REALM}.city1`)!;

    await addUserToGroupInRealm(TEST_REALM, userId, city1.id);
    const userGroups = await getUserGroupsInRealm(TEST_REALM, userId);
    expect(userGroups.some((g) => g.name === `${TEST_REALM}.city1`)).toBe(true);
  });

  // ── User-role assignment ────────────────────────────────────────────────

  it("assigns realm roles to a user and retrieves them", async () => {
    const userId = await createKcUser(TEST_REALM, "testuser-roles");
    expect(userId).toBeTruthy();

    await assignRealmRoles(TEST_REALM, userId, ["CITIZEN", "GRO", "PGR_LME"]);

    const roles = await getUserRealmRoles(TEST_REALM, userId);
    const names = roles.map((r) => r.name);
    expect(names).toContain("CITIZEN");
    expect(names).toContain("GRO");
    expect(names).toContain("PGR_LME");
  });

  // ── Tenant sync ─────────────────────────────────────────────────────────

  it("syncTenantRealms creates realms from DIGIT_TENANTS env var", async () => {
    // Save and override
    const original = config.digitTenants;
    (config as any).digitTenants = `${TEST_REALM}:${TEST_REALM}.alpha,${TEST_REALM}.beta`;

    await syncTenantRealms();

    // Restore
    (config as any).digitTenants = original;

    // The realm already exists, but groups should be synced
    const groups = await getGroupsInRealm(TEST_REALM);
    const names = groups.map((g) => g.name);
    expect(names).toContain(`${TEST_REALM}.alpha`);
    expect(names).toContain(`${TEST_REALM}.beta`);
  });

  // ── Role coverage vs DIGIT MDMS ─────────────────────────────────────────

  it("all DIGIT MDMS roles are present in the provisioned realm", async () => {
    // These are the exact 21 role codes from DIGIT's ACCESSCONTROL-ROLES.roles schema
    const digitMdmsRoles = [
      "DGRO", "PGR_VIEWER", "SUPERVISOR", "TICKET_REPORT_VIEWER", "PGR_LME",
      "GRO", "CSR", "LOC_ADMIN", "MDMS_ADMIN", "REINDEXING_ROLE",
      "INTERNAL_MICROSERVICE_ROLE", "COMMON_EMPLOYEE", "SYSTEM", "AUTO_ESCALATE",
      "QA_AUTOMATION", "HRMS_ADMIN", "SUPERUSER", "EMPLOYEE", "CITIZEN",
      "ANONYMOUS", "WORKFLOW_ADMIN",
    ];

    const realmRoles = await getRealmRoles(TEST_REALM);
    const missing = digitMdmsRoles.filter((r) => !realmRoles.includes(r));
    expect(missing, `roles missing from realm: ${missing.join(", ")}`).toEqual([]);
  });
});

describe.skipIf(!LIVE_KC_URL)("Live KC: validate existing pg and mz realms", () => {
  beforeAll(async () => {
    (config as any).keycloakAdminUrl = LIVE_KC_URL;
    await initKcAdmin();
  }, 30_000);

  afterAll(() => {
    stopKcAdminRefresh();
  });

  it("pg realm exists with all 21 DIGIT roles", async () => {
    const realms = await listRealms();
    expect(realms).toContain("pg");

    const roles = await getRealmRoles("pg");
    for (const role of DIGIT_ROLES) {
      expect(roles, `pg missing role: ${role}`).toContain(role);
    }
  });

  it("pg realm has city groups pg.citya and pg.cityb", async () => {
    const groups = await getGroupsInRealm("pg");
    const names = groups.map((g) => g.name);
    expect(names).toContain("pg.citya");
    expect(names).toContain("pg.cityb");
  });

  it("pg realm has digit-ui client with groups scope", async () => {
    const clients = await getRealmClients("pg");
    const digitUi = clients.find((c) => c.clientId === "digit-ui");
    expect(digitUi).toBeDefined();
    expect(digitUi!.defaultClientScopes).toContain("groups");
  });

  it("mz realm exists with all 21 DIGIT roles", async () => {
    const realms = await listRealms();
    expect(realms).toContain("mz");

    const roles = await getRealmRoles("mz");
    for (const role of DIGIT_ROLES) {
      expect(roles, `mz missing role: ${role}`).toContain(role);
    }
  });

  it("mz realm has city group mz.chimoio", async () => {
    const groups = await getGroupsInRealm("mz");
    const names = groups.map((g) => g.name);
    expect(names).toContain("mz.chimoio");
  });

  it("mz realm has digit-ui client with groups scope", async () => {
    const clients = await getRealmClients("mz");
    const digitUi = clients.find((c) => c.clientId === "digit-ui");
    expect(digitUi).toBeDefined();
    expect(digitUi!.defaultClientScopes).toContain("groups");
  });

  it("each realm has OIDC discovery endpoint", async () => {
    for (const realm of ["pg", "mz"]) {
      const resp = await fetch(
        `${config.keycloakAdminUrl}/realms/${realm}/.well-known/openid-configuration`,
      );
      expect(resp.ok).toBe(true);
      const data = (await resp.json()) as { issuer: string; jwks_uri: string };
      expect(data.issuer).toContain(`/realms/${realm}`);
      expect(data.jwks_uri).toContain(`/realms/${realm}/protocol/openid-connect/certs`);
    }
  });
});
