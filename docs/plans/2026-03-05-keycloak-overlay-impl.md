# Keycloak Overlay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the token-exchange-svc that bridges Keycloak JWTs to DIGIT opaque tokens, with mock DIGIT services and full E2E test coverage.

**Architecture:** A Node.js/TypeScript reverse proxy that validates Keycloak JWTs (via JWKS), lazy-provisions DIGIT users via egov-user API, caches user mappings in Redis, injects a system token into every forwarded request's `RequestInfo`. Mock DIGIT services simulate egov-user and downstream backends for testing.

**Tech Stack:** Node.js 22, TypeScript, Express, `jose` (JWT/JWKS), `ioredis`, Vitest, Docker Compose

**Design Doc:** `docs/plans/2026-03-05-keycloak-acl-design.md` (copy from tilt-demo)

---

## Repository Structure (Target)

```
DIGIT-keycloak-overlay/
├── src/
│   ├── server.ts              # Express app setup, health endpoint, catch-all proxy
│   ├── config.ts              # Environment variable parsing with defaults
│   ├── jwt.ts                 # JWKS fetching + JWT validation via jose
│   ├── cache.ts               # Redis get/set/del with JSON serialization + TTL
│   ├── digit-client.ts        # egov-user HTTP client (search, create, update, login)
│   ├── user-resolver.ts       # Core logic: KC claims → DIGIT user (cache/provision/sync)
│   ├── proxy.ts               # Content-type-aware request forwarding
│   ├── routes.ts              # Upstream service routing map
│   └── types.ts               # Shared TypeScript interfaces
├── mocks/
│   ├── egov-user.ts           # Mock egov-user: oauth/token, _search, _createnovalidate, _updatenovalidate
│   ├── digit-backend.ts       # Mock generic DIGIT backend (echoes RequestInfo back)
│   └── jwks-server.ts         # Mock JWKS endpoint + JWT signing utility
├── tests/
│   ├── setup.ts               # Vitest globalSetup: start mocks, Redis, generate keys
│   ├── helpers.ts             # signJwt(), makeRequest(), cleanup()
│   ├── unit/
│   │   ├── jwt.test.ts        # JWT validation: valid, expired, wrong issuer, bad sig
│   │   ├── cache.test.ts      # Redis cache: get/set/TTL/miss
│   │   ├── user-resolver.test.ts  # Resolve flow: cache hit, miss+provision, miss+existing, sync
│   │   └── routes.test.ts     # Path→upstream mapping
│   └── e2e/
│       ├── auth-flow.test.ts      # Full request: JWT → resolve → inject → forward → response
│       ├── user-provision.test.ts # New user: creates in mock egov-user, caches, forwards
│       ├── user-sync.test.ts      # Name change in JWT → update propagated to egov-user
│       ├── cache-behavior.test.ts # Cache hit skips egov-user, cache miss provisions
│       ├── content-types.test.ts  # JSON rewrite, multipart passthrough, unknown passthrough
│       ├── error-handling.test.ts # No auth header, expired JWT, egov-user down, Redis down
│       └── health.test.ts         # /healthz returns ok when deps are up
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile
├── docker-compose.yml         # Full stack: keycloak, redis, token-exchange, mocks
├── docker-compose.test.yml    # Test stack: redis + mocks only (no keycloak)
├── .gitignore
└── README.md
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/config.ts`
- Create: `src/types.ts`

**Step 1: Initialize package.json**

```json
{
  "name": "digit-keycloak-overlay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "express": "^4.21.0",
    "ioredis": "^5.4.1",
    "jose": "^5.9.6",
    "node-fetch": "^3.3.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests", "mocks"]
}
```

**Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 30000,
    globalSetup: "./tests/setup.ts",
    include: ["tests/**/*.test.ts"],
  },
});
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
*.js.map
.env
```

**Step 5: Create src/config.ts**

All environment variables with sensible defaults for local dev/test.

```typescript
export const config = {
  port: parseInt(process.env.PORT || "3000"),

  // DIGIT egov-user
  digitUserHost: process.env.DIGIT_USER_HOST || "http://localhost:8107",
  digitSystemUsername: process.env.DIGIT_SYSTEM_USERNAME || "INTERNAL_MICROSERVICE_ROLE",
  digitSystemPassword: process.env.DIGIT_SYSTEM_PASSWORD || "eGov@123",
  digitSystemTenant: process.env.DIGIT_SYSTEM_TENANT || "pg",
  digitDefaultTenant: process.env.DIGIT_DEFAULT_TENANT || "pg.citya",

  // Keycloak
  keycloakIssuer: process.env.KEYCLOAK_ISSUER || "http://localhost:8180/realms/digit-sandbox",
  keycloakJwksUri: process.env.KEYCLOAK_JWKS_URI || "http://localhost:8180/realms/digit-sandbox/protocol/openid-connect/certs",

  // Redis
  redisHost: process.env.REDIS_HOST || "localhost",
  redisPort: parseInt(process.env.REDIS_PORT || "6379"),
  cachePrefix: process.env.CACHE_PREFIX || "keycloak",
  cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || "604800"),

  // Upstream routing
  upstreamServices: process.env.UPSTREAM_SERVICES || "",
};
```

**Step 6: Create src/types.ts**

```typescript
export interface KCClaims {
  sub: string;
  email: string;
  name?: string;
  preferred_username?: string;
  email_verified?: boolean;
  phone_number?: string;
}

export interface DigitUser {
  uuid: string;
  userName: string;
  name: string;
  emailId: string;
  mobileNumber: string;
  tenantId: string;
  type: string;
  roles: Array<{ code: string; name: string; tenantId?: string }>;
}

export interface CachedSession {
  user: DigitUser;
  cachedAt: number;
}

export interface DigitLoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  UserRequest: DigitUser;
}
```

**Step 7: Install dependencies and commit**

Run: `cd /root/DIGIT-keycloak-overlay && npm install`

```bash
git add -A
git commit -m "chore: project scaffolding with config, types, and test setup"
```

---

### Task 2: JWT Validation Module

**Files:**
- Create: `src/jwt.ts`
- Create: `mocks/jwks-server.ts`
- Create: `tests/helpers.ts`
- Create: `tests/unit/jwt.test.ts`

**Step 1: Create the mock JWKS server + JWT signing utility**

`mocks/jwks-server.ts` generates an RSA key pair at startup, serves a JWKS endpoint, and exports a `signJwt()` function for tests.

```typescript
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import express from "express";

let privateKey: KeyLike;
let publicJwk: any;
const KID = "test-key-1";
const ISSUER = "http://localhost:9999/realms/digit-sandbox";

export async function initKeys() {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const pub = await exportJWK(keys.publicKey);
  publicJwk = { ...pub, kid: KID, use: "sig", alg: "RS256" };
}

export function getIssuer() { return ISSUER; }

export async function signJwt(claims: Record<string, unknown>, opts?: { expiresIn?: string }) {
  return new SignJWT(claims as any)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts?.expiresIn || "1h")
    .sign(privateKey);
}

export function createJwksApp() {
  const app = express();
  app.get("/realms/digit-sandbox/protocol/openid-connect/certs", (_req, res) => {
    res.json({ keys: [publicJwk] });
  });
  return app;
}
```

**Step 2: Create src/jwt.ts**

```typescript
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { config } from "./config.js";
import type { KCClaims } from "./types.js";

let jwks: ReturnType<typeof createRemoteJWKSet>;

export function initJwks(jwksUri?: string) {
  jwks = createRemoteJWKSet(new URL(jwksUri || config.keycloakJwksUri));
}

export async function validateJwt(authHeader: string | undefined): Promise<KCClaims | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.keycloakIssuer,
    });
    if (!payload.sub || !payload.email) return null;
    return {
      sub: payload.sub,
      email: payload.email as string,
      name: (payload.name as string) || undefined,
      preferred_username: (payload.preferred_username as string) || undefined,
      email_verified: payload.email_verified as boolean | undefined,
      phone_number: (payload.phone_number as string) || undefined,
    };
  } catch {
    return null;
  }
}
```

**Step 3: Create tests/helpers.ts**

```typescript
export { signJwt, getIssuer } from "../mocks/jwks-server.js";

export function makeAuthHeader(token: string) {
  return `Bearer ${token}`;
}
```

**Step 4: Create tests/setup.ts**

Global setup: starts JWKS mock server and exposes port via env var.

```typescript
import type { GlobalSetupContext } from "vitest/node";
import { initKeys, createJwksApp } from "../mocks/jwks-server.js";

let server: any;

export async function setup(ctx: GlobalSetupContext) {
  await initKeys();
  const app = createJwksApp();
  server = app.listen(9999);
  process.env.KEYCLOAK_JWKS_URI = "http://localhost:9999/realms/digit-sandbox/protocol/openid-connect/certs";
  process.env.KEYCLOAK_ISSUER = "http://localhost:9999/realms/digit-sandbox";
}

export async function teardown() {
  server?.close();
}
```

**Step 5: Write failing JWT tests**

`tests/unit/jwt.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { initJwks, validateJwt } from "../../src/jwt.js";
import { signJwt } from "../helpers.js";

beforeAll(() => {
  initJwks(process.env.KEYCLOAK_JWKS_URI);
});

describe("validateJwt", () => {
  it("returns claims for a valid JWT", async () => {
    const token = await signJwt({ sub: "user-1", email: "a@b.com", name: "Alice" });
    const claims = await validateJwt(`Bearer ${token}`);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("user-1");
    expect(claims!.email).toBe("a@b.com");
    expect(claims!.name).toBe("Alice");
  });

  it("returns null for missing auth header", async () => {
    expect(await validateJwt(undefined)).toBeNull();
  });

  it("returns null for non-Bearer header", async () => {
    expect(await validateJwt("Basic abc123")).toBeNull();
  });

  it("returns null for expired JWT", async () => {
    const token = await signJwt({ sub: "user-1", email: "a@b.com" }, { expiresIn: "0s" });
    // small delay to ensure expiry
    await new Promise((r) => setTimeout(r, 1100));
    expect(await validateJwt(`Bearer ${token}`)).toBeNull();
  });

  it("returns null for JWT missing email claim", async () => {
    const token = await signJwt({ sub: "user-1" });
    expect(await validateJwt(`Bearer ${token}`)).toBeNull();
  });

  it("returns null for garbage token", async () => {
    expect(await validateJwt("Bearer not.a.real.jwt")).toBeNull();
  });
});
```

**Step 6: Run tests to verify they fail, then verify they pass after implementation**

Run: `cd /root/DIGIT-keycloak-overlay && npx vitest run tests/unit/jwt.test.ts`
Expected: All 6 tests PASS (since we write implementation and tests together here).

**Step 7: Commit**

```bash
git add src/jwt.ts mocks/jwks-server.ts tests/
git commit -m "feat: JWT validation with JWKS + unit tests"
```

---

### Task 3: Redis Cache Module

**Files:**
- Create: `src/cache.ts`
- Create: `tests/unit/cache.test.ts`

**Step 1: Create src/cache.ts**

```typescript
import Redis from "ioredis";
import { config } from "./config.js";
import type { CachedSession } from "./types.js";

let redis: Redis;

export function initCache(redisUrl?: string) {
  redis = redisUrl
    ? new Redis(redisUrl)
    : new Redis({ host: config.redisHost, port: config.redisPort });
  return redis;
}

export function getRedis() { return redis; }

function cacheKey(sub: string, tenantId: string): string {
  return `${config.cachePrefix}:${sub}:${tenantId}`;
}

export async function getCached(sub: string, tenantId: string): Promise<CachedSession | null> {
  const raw = await redis.get(cacheKey(sub, tenantId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedSession;
  } catch {
    return null;
  }
}

export async function setCached(sub: string, tenantId: string, session: CachedSession): Promise<void> {
  await redis.set(cacheKey(sub, tenantId), JSON.stringify(session), "EX", config.cacheTtlSeconds);
}

export async function delCached(sub: string, tenantId: string): Promise<void> {
  await redis.del(cacheKey(sub, tenantId));
}

export async function closeCache(): Promise<void> {
  await redis?.quit();
}
```

**Step 2: Write cache tests**

`tests/unit/cache.test.ts` — requires Redis running on localhost:6379 (started by docker-compose.test.yml or manually).

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initCache, getCached, setCached, delCached, closeCache, getRedis } from "../../src/cache.js";

beforeAll(() => {
  initCache(process.env.REDIS_URL || "redis://localhost:6379");
});

afterAll(async () => {
  await closeCache();
});

beforeEach(async () => {
  // Clean test keys
  const redis = getRedis();
  const keys = await redis.keys("keycloak:test-*");
  if (keys.length) await redis.del(...keys);
});

describe("cache", () => {
  it("returns null for cache miss", async () => {
    const result = await getCached("test-nonexistent", "pg.citya");
    expect(result).toBeNull();
  });

  it("stores and retrieves a session", async () => {
    const session = {
      user: {
        uuid: "u1", userName: "a@b.com", name: "Alice", emailId: "a@b.com",
        mobileNumber: "9000012345", tenantId: "pg.citya", type: "CITIZEN",
        roles: [{ code: "CITIZEN", name: "Citizen" }],
      },
      cachedAt: Date.now(),
    };
    await setCached("test-sub-1", "pg.citya", session);
    const result = await getCached("test-sub-1", "pg.citya");
    expect(result).not.toBeNull();
    expect(result!.user.uuid).toBe("u1");
    expect(result!.user.emailId).toBe("a@b.com");
  });

  it("deletes a cached session", async () => {
    const session = {
      user: {
        uuid: "u2", userName: "b@c.com", name: "Bob", emailId: "b@c.com",
        mobileNumber: "9000012346", tenantId: "pg.citya", type: "CITIZEN",
        roles: [{ code: "CITIZEN", name: "Citizen" }],
      },
      cachedAt: Date.now(),
    };
    await setCached("test-sub-2", "pg.citya", session);
    await delCached("test-sub-2", "pg.citya");
    expect(await getCached("test-sub-2", "pg.citya")).toBeNull();
  });

  it("scopes cache by tenant", async () => {
    const session1 = {
      user: { uuid: "u3", userName: "c@d.com", name: "Carol", emailId: "c@d.com",
        mobileNumber: "9000012347", tenantId: "pg.citya", type: "CITIZEN",
        roles: [{ code: "CITIZEN", name: "Citizen" }] },
      cachedAt: Date.now(),
    };
    const session2 = { ...session1, user: { ...session1.user, uuid: "u4", tenantId: "pg.cityb" } };
    await setCached("test-sub-3", "pg.citya", session1);
    await setCached("test-sub-3", "pg.cityb", session2);
    const r1 = await getCached("test-sub-3", "pg.citya");
    const r2 = await getCached("test-sub-3", "pg.cityb");
    expect(r1!.user.uuid).toBe("u3");
    expect(r2!.user.uuid).toBe("u4");
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run tests/unit/cache.test.ts`

Note: Requires Redis on localhost:6379. Start with `docker run -d --name test-redis -p 6379:6379 redis:7` if not running.

**Step 4: Commit**

```bash
git add src/cache.ts tests/unit/cache.test.ts
git commit -m "feat: Redis cache module with TTL + unit tests"
```

---

### Task 4: DIGIT Client (egov-user API)

**Files:**
- Create: `src/digit-client.ts`
- Create: `mocks/egov-user.ts`
- Create: `tests/unit/digit-client.test.ts` (optional, covered by E2E)

**Step 1: Create mock egov-user server**

`mocks/egov-user.ts` — in-memory user store, implements the 4 egov-user endpoints.

```typescript
import express from "express";
import type { DigitUser } from "../src/types.js";

interface StoredUser extends DigitUser {
  password: string;
}

export function createEgovUserMock() {
  const app = express();
  app.use(express.json());
  const users: Map<string, StoredUser> = new Map();
  let nextId = 1;

  // System login token
  const SYSTEM_TOKEN = "mock-system-token-12345";

  // POST /user/oauth/token (form-urlencoded)
  app.post("/user/oauth/token", express.urlencoded({ extended: true }), (req, res) => {
    const { username, password, tenantId, userType } = req.body;
    // System user login
    if (username === "INTERNAL_MICROSERVICE_ROLE") {
      return res.json({
        access_token: SYSTEM_TOKEN,
        token_type: "bearer",
        expires_in: 604800,
        UserRequest: {
          uuid: "system-uuid", userName: username, name: "System",
          emailId: "", mobileNumber: "", tenantId: tenantId || "pg",
          type: "SYSTEM", roles: [{ code: "EMPLOYEE", name: "Employee" }],
        },
      });
    }
    // Regular user — find by userName
    const user = Array.from(users.values()).find(u => u.userName === username);
    if (!user) return res.status(401).json({ error: "User not found" });
    res.json({
      access_token: `token-for-${user.uuid}`,
      token_type: "bearer",
      expires_in: 604800,
      UserRequest: { ...user, password: undefined },
    });
  });

  // POST /user/_search
  app.post("/user/_search", (req, res) => {
    const { emailId, userName, tenantId } = req.body;
    const matches = Array.from(users.values()).filter(u => {
      if (emailId && u.emailId !== emailId) return false;
      if (userName && u.userName !== userName) return false;
      return true;
    });
    res.json({ user: matches.map(u => ({ ...u, password: undefined })) });
  });

  // POST /user/users/_createnovalidate
  app.post("/user/users/_createnovalidate", (req, res) => {
    const userData = req.body.user;
    const uuid = `uuid-${nextId++}`;
    const newUser: StoredUser = {
      uuid,
      userName: userData.userName || userData.emailId,
      name: userData.name,
      emailId: userData.emailId,
      mobileNumber: userData.mobileNumber || "9999900000",
      tenantId: userData.tenantId,
      type: userData.type || "CITIZEN",
      roles: userData.roles || [{ code: "CITIZEN", name: "Citizen" }],
      password: userData.password || "random",
    };
    users.set(uuid, newUser);
    res.json({ user: [{ ...newUser, password: undefined }] });
  });

  // POST /user/users/_updatenovalidate
  app.post("/user/users/_updatenovalidate", (req, res) => {
    const userData = req.body.user;
    const existing = users.get(userData.uuid);
    if (!existing) return res.status(404).json({ error: "User not found" });
    const updated = { ...existing, ...userData, password: existing.password };
    users.set(userData.uuid, updated);
    res.json({ user: [{ ...updated, password: undefined }] });
  });

  return { app, users, SYSTEM_TOKEN };
}
```

**Step 2: Create src/digit-client.ts**

```typescript
import { config } from "./config.js";
import type { DigitUser, DigitLoginResponse } from "./types.js";
import { createHash, randomBytes } from "node:crypto";

let systemToken: string | null = null;
let systemTokenRefreshTimer: ReturnType<typeof setInterval> | null = null;

function digitUrl(path: string): string {
  return `${config.digitUserHost}${path}`;
}

export async function initSystemToken(): Promise<string> {
  const params = new URLSearchParams({
    username: config.digitSystemUsername,
    password: config.digitSystemPassword,
    tenantId: config.digitSystemTenant,
    userType: "SYSTEM",
    grant_type: "password",
    scope: "read",
  });
  const resp = await fetch(digitUrl("/user/oauth/token"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic ZWdvdi11c2VyLWNsaWVudDo=", // base64("egov-user-client:")
    },
    body: params.toString(),
  });
  if (!resp.ok) throw new Error(`System login failed: ${resp.status}`);
  const data = (await resp.json()) as DigitLoginResponse;
  systemToken = data.access_token;
  return systemToken;
}

export function getSystemToken(): string {
  if (!systemToken) throw new Error("System token not initialized");
  return systemToken;
}

export function startTokenRefresh(intervalMs = 6 * 24 * 60 * 60 * 1000) {
  systemTokenRefreshTimer = setInterval(() => { initSystemToken().catch(console.error); }, intervalMs);
}

export function stopTokenRefresh() {
  if (systemTokenRefreshTimer) clearInterval(systemTokenRefreshTimer);
}

export async function searchUser(emailId: string, tenantId: string): Promise<DigitUser | null> {
  const resp = await fetch(digitUrl("/user/_search"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
      emailId,
      tenantId,
      pageSize: 1,
    }),
  });
  if (!resp.ok) return null;
  const data = await resp.json() as { user: DigitUser[] };
  return data.user?.[0] || null;
}

export async function createUser(params: {
  name: string; email: string; tenantId: string; keycloakSub: string;
  phoneNumber?: string;
}): Promise<DigitUser> {
  const mobileHash = parseInt(createHash("sha256").update(params.keycloakSub).digest("hex").slice(0, 5), 16) % 100000;
  const resp = await fetch(digitUrl("/user/users/_createnovalidate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
      user: {
        userName: params.email,
        name: params.name,
        emailId: params.email,
        mobileNumber: params.phoneNumber || `90000${String(mobileHash).padStart(5, "0")}`,
        password: randomBytes(32).toString("hex"),
        tenantId: params.tenantId,
        type: "CITIZEN",
        active: true,
        roles: [{ code: "CITIZEN", name: "Citizen", tenantId: params.tenantId }],
      },
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`User creation failed: ${resp.status} ${err}`);
  }
  const data = await resp.json() as { user: DigitUser[] };
  return data.user[0];
}

export async function updateUser(uuid: string, updates: { name?: string; emailId?: string }): Promise<void> {
  await fetch(digitUrl("/user/users/_updatenovalidate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
      user: { uuid, ...updates },
    }),
  });
}
```

**Step 3: Commit**

```bash
git add src/digit-client.ts mocks/egov-user.ts
git commit -m "feat: DIGIT egov-user client + mock server"
```

---

### Task 5: User Resolver (Core Logic)

**Files:**
- Create: `src/user-resolver.ts`
- Create: `tests/unit/user-resolver.test.ts`

**Step 1: Create src/user-resolver.ts**

```typescript
import type { KCClaims, DigitUser, CachedSession } from "./types.js";
import { getCached, setCached } from "./cache.js";
import { searchUser, createUser, updateUser } from "./digit-client.js";
import { config } from "./config.js";

export async function resolveUser(claims: KCClaims, tenantId: string): Promise<DigitUser> {
  const effectiveTenant = tenantId || config.digitDefaultTenant;

  // 1. Check cache
  const cached = await getCached(claims.sub, effectiveTenant);
  if (cached) {
    // Sync check
    const nameChanged = claims.name && cached.user.name !== claims.name;
    const emailChanged = cached.user.emailId !== claims.email;
    if (nameChanged || emailChanged) {
      const updates: { name?: string; emailId?: string } = {};
      if (nameChanged) updates.name = claims.name!;
      if (emailChanged) updates.emailId = claims.email;
      await updateUser(cached.user.uuid, updates).catch(() => {}); // best-effort
      cached.user.name = claims.name || cached.user.name;
      cached.user.emailId = claims.email;
      await setCached(claims.sub, effectiveTenant, cached);
    }
    return cached.user;
  }

  // 2. Search for existing DIGIT user by email
  let digitUser = await searchUser(claims.email, effectiveTenant);

  // 3. Lazy provision if not found
  if (!digitUser) {
    digitUser = await createUser({
      name: claims.name || claims.preferred_username || claims.email,
      email: claims.email,
      tenantId: effectiveTenant,
      keycloakSub: claims.sub,
      phoneNumber: claims.phone_number,
    });
  }

  // 4. Cache
  const session: CachedSession = { user: digitUser, cachedAt: Date.now() };
  await setCached(claims.sub, effectiveTenant, session);

  return digitUser;
}
```

**Step 2: Write user-resolver unit tests**

These tests start the mock egov-user and Redis, then exercise the resolve flow.

`tests/unit/user-resolver.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initCache, closeCache, getRedis, getCached } from "../../src/cache.js";
import { initSystemToken } from "../../src/digit-client.js";
import { resolveUser } from "../../src/user-resolver.js";
import { createEgovUserMock } from "../../mocks/egov-user.js";
import type { KCClaims } from "../../src/types.js";

let egovServer: any;
let egovMock: ReturnType<typeof createEgovUserMock>;

beforeAll(async () => {
  // Start mock egov-user
  egovMock = createEgovUserMock();
  egovServer = egovMock.app.listen(8107);
  process.env.DIGIT_USER_HOST = "http://localhost:8107";

  // Init Redis + system token
  initCache("redis://localhost:6379");
  // Re-import config to pick up env var
  const { config } = await import("../../src/config.js");
  (config as any).digitUserHost = "http://localhost:8107";
  await initSystemToken();
});

afterAll(async () => {
  egovServer?.close();
  await closeCache();
});

beforeEach(async () => {
  // Clear cache and mock user store
  const redis = getRedis();
  const keys = await redis.keys("keycloak:*");
  if (keys.length) await redis.del(...keys);
  egovMock.users.clear();
});

describe("resolveUser", () => {
  const baseClaims: KCClaims = {
    sub: "kc-sub-1",
    email: "alice@example.com",
    name: "Alice Smith",
  };

  it("provisions a new DIGIT user on cache miss", async () => {
    const user = await resolveUser(baseClaims, "pg.citya");
    expect(user.emailId).toBe("alice@example.com");
    expect(user.name).toBe("Alice Smith");
    expect(user.type).toBe("CITIZEN");
    expect(user.uuid).toBeTruthy();
    // Verify it's now cached
    const cached = await getCached("kc-sub-1", "pg.citya");
    expect(cached).not.toBeNull();
    expect(cached!.user.emailId).toBe("alice@example.com");
  });

  it("returns cached user on cache hit without calling egov-user", async () => {
    // First call provisions
    const user1 = await resolveUser(baseClaims, "pg.citya");
    // Second call should return same user from cache
    const user2 = await resolveUser(baseClaims, "pg.citya");
    expect(user2.uuid).toBe(user1.uuid);
  });

  it("finds existing DIGIT user by email instead of creating new", async () => {
    // Pre-populate mock egov-user with a user
    egovMock.users.set("existing-uuid", {
      uuid: "existing-uuid", userName: "alice@example.com", name: "Alice Old",
      emailId: "alice@example.com", mobileNumber: "9000012345",
      tenantId: "pg.citya", type: "CITIZEN",
      roles: [{ code: "CITIZEN", name: "Citizen" }], password: "x",
    });
    const user = await resolveUser(baseClaims, "pg.citya");
    expect(user.uuid).toBe("existing-uuid");
  });

  it("syncs name change from Keycloak claims to cached DIGIT user", async () => {
    // Provision user
    await resolveUser(baseClaims, "pg.citya");
    // Change name in claims
    const updatedClaims = { ...baseClaims, name: "Alice Johnson" };
    const user = await resolveUser(updatedClaims, "pg.citya");
    expect(user.name).toBe("Alice Johnson");
  });

  it("scopes users by tenant", async () => {
    const user1 = await resolveUser(baseClaims, "pg.citya");
    const user2 = await resolveUser(baseClaims, "pg.cityb");
    // Different tenants, different DIGIT users
    expect(user1.uuid).not.toBe(user2.uuid);
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run tests/unit/user-resolver.test.ts`

**Step 4: Commit**

```bash
git add src/user-resolver.ts tests/unit/user-resolver.test.ts
git commit -m "feat: user resolver with lazy provisioning + sync + unit tests"
```

---

### Task 6: Upstream Route Mapping

**Files:**
- Create: `src/routes.ts`
- Create: `tests/unit/routes.test.ts`

**Step 1: Create src/routes.ts**

```typescript
import { config } from "./config.js";

const routeMap = new Map<string, string>();

// Default DIGIT service routes (path prefix → host:port)
const DEFAULT_ROUTES: Record<string, string> = {
  "/pgr-services": "pgr-services:8082",
  "/egov-workflow-v2": "egov-workflow-v2:8109",
  "/mdms-v2": "mdms-v2:8094",
  "/egov-hrms": "egov-hrms:8098",
  "/boundary-service": "boundary-service:8081",
  "/egov-filestore": "egov-filestore:8084",
  "/egov-idgen": "egov-idgen:8088",
  "/egov-localization": "egov-localization:8096",
  "/egov-accesscontrol": "egov-accesscontrol:8090",
  "/egov-indexer": "egov-indexer:8095",
  "/inbox": "inbox:8097",
  "/user": "egov-user:8107",
};

export function initRoutes() {
  // Load defaults
  for (const [path, hostPort] of Object.entries(DEFAULT_ROUTES)) {
    routeMap.set(path, `http://${hostPort}`);
  }

  // Override from env UPSTREAM_SERVICES (comma-separated "service:port" pairs)
  if (config.upstreamServices) {
    const entries = config.upstreamServices.split(",").map(s => s.trim()).filter(Boolean);
    for (const entry of entries) {
      const [service, port] = entry.split(":");
      if (service && port) {
        // Map service name to path prefix (e.g., "pgr-services:8082" → "/pgr-services")
        routeMap.set(`/${service}`, `http://${service}:${port}`);
      }
    }
  }
}

export function resolveUpstream(requestPath: string): string | null {
  // Match longest prefix
  const segments = requestPath.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const prefix = `/${segments[0]}`;
  const upstream = routeMap.get(prefix);
  if (!upstream) return null;
  return `${upstream}${requestPath}`;
}

export function getRouteMap(): Map<string, string> {
  return routeMap;
}
```

**Step 2: Write route tests**

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { initRoutes, resolveUpstream } from "../../src/routes.js";

beforeAll(() => {
  initRoutes();
});

describe("resolveUpstream", () => {
  it("maps /pgr-services path to upstream", () => {
    const url = resolveUpstream("/pgr-services/v2/_search");
    expect(url).toBe("http://pgr-services:8082/pgr-services/v2/_search");
  });

  it("maps /mdms-v2 path to upstream", () => {
    const url = resolveUpstream("/mdms-v2/v1/_search");
    expect(url).toBe("http://mdms-v2:8094/mdms-v2/v1/_search");
  });

  it("returns null for unknown path", () => {
    expect(resolveUpstream("/unknown-service/foo")).toBeNull();
  });

  it("returns null for empty path", () => {
    expect(resolveUpstream("/")).toBeNull();
  });
});
```

**Step 3: Commit**

```bash
git add src/routes.ts tests/unit/routes.test.ts
git commit -m "feat: upstream route mapping with path prefix matching"
```

---

### Task 7: Proxy + Server (Express App)

**Files:**
- Create: `src/proxy.ts`
- Create: `src/server.ts`
- Create: `mocks/digit-backend.ts`

**Step 1: Create mock DIGIT backend**

`mocks/digit-backend.ts` — echoes back the RequestInfo it receives (so tests can verify injection).

```typescript
import express from "express";

export function createDigitBackendMock() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Echo back the RequestInfo and path for verification
  app.all("*", (req, res) => {
    res.json({
      echo: true,
      path: req.path,
      method: req.method,
      receivedRequestInfo: req.body?.RequestInfo || null,
      receivedBody: req.body || null,
      headers: {
        authorization: req.headers.authorization || null,
        "content-type": req.headers["content-type"] || null,
      },
      query: req.query,
    });
  });

  return app;
}
```

**Step 2: Create src/proxy.ts**

```typescript
import type { Request, Response } from "express";
import { resolveUpstream } from "./routes.js";
import { getSystemToken } from "./digit-client.js";
import type { DigitUser } from "./types.js";

export async function proxyRequest(req: Request, res: Response, digitUser: DigitUser): Promise<void> {
  const upstream = resolveUpstream(req.path);
  if (!upstream) {
    res.status(404).json({ error: "No upstream service for path", path: req.path });
    return;
  }

  const contentType = req.headers["content-type"] || "";
  const systemToken = getSystemToken();

  try {
    if (contentType.includes("application/json")) {
      // JSON: rewrite RequestInfo in body
      const body = req.body || {};
      body.RequestInfo = body.RequestInfo || {};
      body.RequestInfo.authToken = systemToken;
      body.RequestInfo.userInfo = digitUser;

      const upstreamResp = await fetch(upstream, {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      res.status(upstreamResp.status);
      // Forward content-type from upstream
      const ct = upstreamResp.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const responseBody = await upstreamResp.text();
      res.send(responseBody);

    } else if (contentType.includes("multipart/form-data")) {
      // Multipart: stream body, pass token via query param
      const url = new URL(upstream);
      url.searchParams.set("auth-token", systemToken);

      // Pipe the raw request to upstream
      const upstreamResp = await fetch(url.toString(), {
        method: req.method,
        headers: {
          "Content-Type": req.headers["content-type"]!,
          "Content-Length": req.headers["content-length"] || "",
        },
        body: req as any, // stream the request body
        duplex: "half" as any,
      });

      res.status(upstreamResp.status);
      const ct = upstreamResp.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const responseBody = await upstreamResp.text();
      res.send(responseBody);

    } else {
      // Unknown content type: pass-through with auth header
      const upstreamResp = await fetch(upstream, {
        method: req.method,
        headers: {
          ...Object.fromEntries(
            Object.entries(req.headers).filter(([k]) => !["host", "connection"].includes(k))
          ) as Record<string, string>,
          Authorization: `Bearer ${systemToken}`,
        },
        body: ["GET", "HEAD"].includes(req.method) ? undefined : (req as any),
        duplex: "half" as any,
      });

      res.status(upstreamResp.status);
      const ct = upstreamResp.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const responseBody = await upstreamResp.text();
      res.send(responseBody);
    }
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(502).json({ error: "Bad gateway", details: String(err) });
  }
}
```

**Step 3: Create src/server.ts**

```typescript
import express from "express";
import { config } from "./config.js";
import { initJwks, validateJwt } from "./jwt.js";
import { initCache, getRedis, closeCache } from "./cache.js";
import { initSystemToken, startTokenRefresh, stopTokenRefresh } from "./digit-client.js";
import { resolveUser } from "./user-resolver.js";
import { initRoutes } from "./routes.js";
import { proxyRequest } from "./proxy.js";

export async function createApp() {
  const app = express();

  // Parse JSON bodies (needed for RequestInfo injection)
  app.use(express.json({ limit: "10mb" }));

  // Health check
  app.get("/healthz", async (_req, res) => {
    try {
      const redis = getRedis();
      await redis.ping();
      res.json({ status: "ok", redis: "connected" });
    } catch {
      res.status(503).json({ status: "unhealthy", redis: "disconnected" });
    }
  });

  // Main proxy handler
  app.all("*", async (req, res) => {
    // Skip health check (already handled)
    if (req.path === "/healthz") return;

    // 1. Validate JWT
    const claims = await validateJwt(req.headers.authorization);
    if (!claims) {
      return res.status(401).json({ error: "Unauthorized", message: "Invalid or missing Keycloak JWT" });
    }

    // 2. Extract tenantId from request body
    const tenantId = req.body?.RequestInfo?.userInfo?.tenantId
      || req.body?.tenantId
      || config.digitDefaultTenant;

    // 3. Resolve Keycloak user → DIGIT user
    try {
      const digitUser = await resolveUser(claims, tenantId);

      // 4. Proxy to upstream with injected auth
      await proxyRequest(req, res, digitUser);
    } catch (err) {
      console.error("User resolution error:", err);
      res.status(500).json({ error: "Internal error", message: "Failed to resolve user" });
    }
  });

  return app;
}

// Start server when run directly
const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  (async () => {
    initJwks();
    initCache();
    initRoutes();
    await initSystemToken();
    startTokenRefresh();

    const app = await createApp();
    app.listen(config.port, () => {
      console.log(`token-exchange-svc listening on :${config.port}`);
    });

    process.on("SIGTERM", async () => {
      stopTokenRefresh();
      await closeCache();
      process.exit(0);
    });
  })();
}
```

**Step 4: Commit**

```bash
git add src/proxy.ts src/server.ts mocks/digit-backend.ts
git commit -m "feat: Express server with proxy, health check, and catch-all handler"
```

---

### Task 8: E2E Integration Tests

**Files:**
- Create: `tests/e2e/auth-flow.test.ts`
- Create: `tests/e2e/user-provision.test.ts`
- Create: `tests/e2e/user-sync.test.ts`
- Create: `tests/e2e/cache-behavior.test.ts`
- Create: `tests/e2e/content-types.test.ts`
- Create: `tests/e2e/error-handling.test.ts`
- Create: `tests/e2e/health.test.ts`
- Modify: `tests/setup.ts` (add mock servers)

**Step 1: Update tests/setup.ts to start all mocks + the app**

```typescript
import type { GlobalSetupContext } from "vitest/node";
import { initKeys, createJwksApp } from "../mocks/jwks-server.js";
import { createEgovUserMock } from "../mocks/egov-user.js";
import { createDigitBackendMock } from "../mocks/digit-backend.js";

let servers: any[] = [];

export async function setup(ctx: GlobalSetupContext) {
  await initKeys();

  // 1. JWKS server on :9999
  const jwksApp = createJwksApp();
  servers.push(jwksApp.listen(9999));

  // 2. Mock egov-user on :8107
  const { app: egovApp } = createEgovUserMock();
  servers.push(egovApp.listen(8107));

  // 3. Mock DIGIT backend on :8082 (pgr-services) and :8109 (workflow)
  const backendApp = createDigitBackendMock();
  servers.push(backendApp.listen(8082));
  servers.push(backendApp.listen(8109));

  // Set env vars for the token-exchange-svc
  process.env.KEYCLOAK_JWKS_URI = "http://localhost:9999/realms/digit-sandbox/protocol/openid-connect/certs";
  process.env.KEYCLOAK_ISSUER = "http://localhost:9999/realms/digit-sandbox";
  process.env.DIGIT_USER_HOST = "http://localhost:8107";
  process.env.REDIS_HOST = "localhost";
  process.env.REDIS_PORT = "6379";
  process.env.UPSTREAM_SERVICES = "pgr-services:localhost:8082,egov-workflow-v2:localhost:8109";

  // Store ports for tests
  (globalThis as any).__TEST_PORTS__ = { jwks: 9999, egovUser: 8107, backend: 8082 };
}

export async function teardown() {
  for (const s of servers) s?.close();
}
```

Note: The `UPSTREAM_SERVICES` format needs to include localhost for tests. We'll adjust `routes.ts` to support `service:host:port` as well as `service:port` format. In tests, override route map directly.

**Step 2: Create tests/e2e/auth-flow.test.ts**

Full happy path: signed JWT → token-exchange-svc → RequestInfo injected → upstream echoes back.

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createApp } from "../../src/server.js";
import { initJwks } from "../../src/jwt.js";
import { initCache, closeCache, getRedis } from "../../src/cache.js";
import { initSystemToken } from "../../src/digit-client.js";
import { initRoutes, getRouteMap } from "../../src/routes.js";
import { signJwt } from "../helpers.js";
import type { Server } from "node:http";

let server: Server;
let appPort: number;

beforeAll(async () => {
  initJwks(process.env.KEYCLOAK_JWKS_URI);
  initCache("redis://localhost:6379");
  initRoutes();
  // Override route to point to local mock backend
  getRouteMap().set("/pgr-services", "http://localhost:8082");
  getRouteMap().set("/egov-workflow-v2", "http://localhost:8109");

  await initSystemToken();
  const app = await createApp();
  server = app.listen(0); // random port
  appPort = (server.address() as any).port;
});

afterAll(async () => {
  server?.close();
  await closeCache();
});

beforeEach(async () => {
  const redis = getRedis();
  const keys = await redis.keys("keycloak:*");
  if (keys.length) await redis.del(...keys);
});

describe("E2E: auth flow", () => {
  it("proxies request with valid JWT and injects RequestInfo", async () => {
    const token = await signJwt({ sub: "e2e-user-1", email: "e2e@test.com", name: "E2E User" });

    const resp = await fetch(`http://localhost:${appPort}/pgr-services/v2/_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        RequestInfo: { apiId: "Rainmaker" },
        tenantId: "pg.citya",
      }),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.echo).toBe(true);
    expect(body.receivedRequestInfo.authToken).toBeTruthy();
    expect(body.receivedRequestInfo.userInfo.emailId).toBe("e2e@test.com");
    expect(body.receivedRequestInfo.userInfo.type).toBe("CITIZEN");
  });

  it("returns 401 for request without Authorization header", async () => {
    const resp = await fetch(`http://localhost:${appPort}/pgr-services/v2/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ RequestInfo: {} }),
    });
    expect(resp.status).toBe(401);
  });

  it("returns 401 for expired JWT", async () => {
    const token = await signJwt({ sub: "e2e-expired", email: "exp@test.com" }, { expiresIn: "0s" });
    await new Promise(r => setTimeout(r, 1100));

    const resp = await fetch(`http://localhost:${appPort}/pgr-services/v2/_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ RequestInfo: {} }),
    });
    expect(resp.status).toBe(401);
  });
});
```

**Step 3: Create tests/e2e/user-provision.test.ts**

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createApp } from "../../src/server.js";
import { initJwks } from "../../src/jwt.js";
import { initCache, closeCache, getRedis, getCached } from "../../src/cache.js";
import { initSystemToken } from "../../src/digit-client.js";
import { initRoutes, getRouteMap } from "../../src/routes.js";
import { signJwt } from "../helpers.js";
import type { Server } from "node:http";

let server: Server;
let appPort: number;

beforeAll(async () => {
  initJwks(process.env.KEYCLOAK_JWKS_URI);
  initCache("redis://localhost:6379");
  initRoutes();
  getRouteMap().set("/pgr-services", "http://localhost:8082");
  await initSystemToken();
  const app = await createApp();
  server = app.listen(0);
  appPort = (server.address() as any).port;
});

afterAll(async () => { server?.close(); await closeCache(); });

beforeEach(async () => {
  const redis = getRedis();
  const keys = await redis.keys("keycloak:*");
  if (keys.length) await redis.del(...keys);
});

describe("E2E: user provisioning", () => {
  it("creates a new DIGIT user on first request", async () => {
    const token = await signJwt({ sub: "new-user-1", email: "new@test.com", name: "New User" });

    const resp = await fetch(`http://localhost:${appPort}/pgr-services/v2/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
    });
    expect(resp.status).toBe(200);

    // Verify user is cached
    const cached = await getCached("new-user-1", "pg.citya");
    expect(cached).not.toBeNull();
    expect(cached!.user.emailId).toBe("new@test.com");
    expect(cached!.user.name).toBe("New User");
    expect(cached!.user.mobileNumber).toMatch(/^90000\d{5}$/);
  });

  it("generates unique mobile numbers per user", async () => {
    const token1 = await signJwt({ sub: "mobile-1", email: "m1@test.com", name: "M1" });
    const token2 = await signJwt({ sub: "mobile-2", email: "m2@test.com", name: "M2" });

    await fetch(`http://localhost:${appPort}/pgr-services/v2/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
    });
    await fetch(`http://localhost:${appPort}/pgr-services/v2/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token2}` },
      body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
    });

    const c1 = await getCached("mobile-1", "pg.citya");
    const c2 = await getCached("mobile-2", "pg.citya");
    expect(c1!.user.mobileNumber).not.toBe(c2!.user.mobileNumber);
  });
});
```

**Step 4: Create tests/e2e/cache-behavior.test.ts**

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createApp } from "../../src/server.js";
import { initJwks } from "../../src/jwt.js";
import { initCache, closeCache, getRedis, setCached } from "../../src/cache.js";
import { initSystemToken } from "../../src/digit-client.js";
import { initRoutes, getRouteMap } from "../../src/routes.js";
import { signJwt } from "../helpers.js";
import type { Server } from "node:http";

let server: Server;
let appPort: number;

beforeAll(async () => {
  initJwks(process.env.KEYCLOAK_JWKS_URI);
  initCache("redis://localhost:6379");
  initRoutes();
  getRouteMap().set("/pgr-services", "http://localhost:8082");
  await initSystemToken();
  const app = await createApp();
  server = app.listen(0);
  appPort = (server.address() as any).port;
});

afterAll(async () => { server?.close(); await closeCache(); });

beforeEach(async () => {
  const redis = getRedis();
  const keys = await redis.keys("keycloak:*");
  if (keys.length) await redis.del(...keys);
});

describe("E2E: cache behavior", () => {
  it("serves from cache on second request (no egov-user call)", async () => {
    const token = await signJwt({ sub: "cache-user", email: "cache@test.com", name: "Cache" });
    const url = `http://localhost:${appPort}/pgr-services/v2/_search`;
    const opts = {
      method: "POST" as const,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
    };

    // First request (provisions)
    const r1 = await fetch(url, opts);
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as any;

    // Second request (cache hit)
    const r2 = await fetch(url, opts);
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as any;

    // Same user UUID in both
    expect(b2.receivedRequestInfo.userInfo.uuid).toBe(b1.receivedRequestInfo.userInfo.uuid);
  });

  it("uses pre-populated cache entry", async () => {
    // Pre-populate cache
    await setCached("pre-cached", "pg.citya", {
      user: {
        uuid: "pre-uuid", userName: "pre@test.com", name: "Pre Cached",
        emailId: "pre@test.com", mobileNumber: "9000099999",
        tenantId: "pg.citya", type: "CITIZEN",
        roles: [{ code: "CITIZEN", name: "Citizen" }],
      },
      cachedAt: Date.now(),
    });

    const token = await signJwt({ sub: "pre-cached", email: "pre@test.com", name: "Pre Cached" });
    const resp = await fetch(`http://localhost:${appPort}/pgr-services/v2/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
    });
    const body = await resp.json() as any;
    expect(body.receivedRequestInfo.userInfo.uuid).toBe("pre-uuid");
  });
});
```

**Step 5: Create tests/e2e/user-sync.test.ts**

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createApp } from "../../src/server.js";
import { initJwks } from "../../src/jwt.js";
import { initCache, closeCache, getRedis, getCached, setCached } from "../../src/cache.js";
import { initSystemToken } from "../../src/digit-client.js";
import { initRoutes, getRouteMap } from "../../src/routes.js";
import { signJwt } from "../helpers.js";
import type { Server } from "node:http";

let server: Server;
let appPort: number;

beforeAll(async () => {
  initJwks(process.env.KEYCLOAK_JWKS_URI);
  initCache("redis://localhost:6379");
  initRoutes();
  getRouteMap().set("/pgr-services", "http://localhost:8082");
  await initSystemToken();
  const app = await createApp();
  server = app.listen(0);
  appPort = (server.address() as any).port;
});

afterAll(async () => { server?.close(); await closeCache(); });

beforeEach(async () => {
  const redis = getRedis();
  const keys = await redis.keys("keycloak:*");
  if (keys.length) await redis.del(...keys);
});

describe("E2E: user sync", () => {
  it("updates cached name when Keycloak name changes", async () => {
    // Pre-populate cache with old name
    await setCached("sync-user", "pg.citya", {
      user: {
        uuid: "sync-uuid", userName: "sync@test.com", name: "Old Name",
        emailId: "sync@test.com", mobileNumber: "9000011111",
        tenantId: "pg.citya", type: "CITIZEN",
        roles: [{ code: "CITIZEN", name: "Citizen" }],
      },
      cachedAt: Date.now(),
    });

    // Request with new name in JWT
    const token = await signJwt({ sub: "sync-user", email: "sync@test.com", name: "New Name" });
    await fetch(`http://localhost:${appPort}/pgr-services/v2/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
    });

    const cached = await getCached("sync-user", "pg.citya");
    expect(cached!.user.name).toBe("New Name");
  });
});
```

**Step 6: Create tests/e2e/error-handling.test.ts**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../../src/server.js";
import { initJwks } from "../../src/jwt.js";
import { initCache, closeCache } from "../../src/cache.js";
import { initSystemToken } from "../../src/digit-client.js";
import { initRoutes, getRouteMap } from "../../src/routes.js";
import { signJwt } from "../helpers.js";
import type { Server } from "node:http";

let server: Server;
let appPort: number;

beforeAll(async () => {
  initJwks(process.env.KEYCLOAK_JWKS_URI);
  initCache("redis://localhost:6379");
  initRoutes();
  getRouteMap().set("/pgr-services", "http://localhost:8082");
  await initSystemToken();
  const app = await createApp();
  server = app.listen(0);
  appPort = (server.address() as any).port;
});

afterAll(async () => { server?.close(); await closeCache(); });

describe("E2E: error handling", () => {
  it("returns 401 for garbage token", async () => {
    const resp = await fetch(`http://localhost:${appPort}/pgr-services/v2/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer garbage" },
      body: JSON.stringify({ RequestInfo: {} }),
    });
    expect(resp.status).toBe(401);
  });

  it("returns 404 for unknown upstream path", async () => {
    const token = await signJwt({ sub: "err-user", email: "err@test.com", name: "Err" });
    const resp = await fetch(`http://localhost:${appPort}/unknown-service/foo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ RequestInfo: {}, tenantId: "pg.citya" }),
    });
    expect(resp.status).toBe(404);
  });
});
```

**Step 7: Create tests/e2e/health.test.ts**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../../src/server.js";
import { initJwks } from "../../src/jwt.js";
import { initCache, closeCache } from "../../src/cache.js";
import { initRoutes } from "../../src/routes.js";
import { initSystemToken } from "../../src/digit-client.js";
import type { Server } from "node:http";

let server: Server;
let appPort: number;

beforeAll(async () => {
  initJwks(process.env.KEYCLOAK_JWKS_URI);
  initCache("redis://localhost:6379");
  initRoutes();
  await initSystemToken();
  const app = await createApp();
  server = app.listen(0);
  appPort = (server.address() as any).port;
});

afterAll(async () => { server?.close(); await closeCache(); });

describe("E2E: health check", () => {
  it("returns ok when Redis is connected", async () => {
    const resp = await fetch(`http://localhost:${appPort}/healthz`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.status).toBe("ok");
    expect(body.redis).toBe("connected");
  });
});
```

**Step 8: Run all tests**

Run: `npx vitest run`

Expected: All unit + E2E tests pass. Requires Redis on localhost:6379 and ports 8082, 8107, 9999 free.

**Step 9: Commit**

```bash
git add tests/e2e/ tests/setup.ts
git commit -m "test: E2E integration tests for auth flow, provisioning, sync, cache, errors, health"
```

---

### Task 9: Dockerfile + Docker Compose

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `docker-compose.test.yml`

**Step 1: Create Dockerfile**

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

**Step 2: Create docker-compose.yml (full stack)**

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  keycloak:
    image: quay.io/keycloak/keycloak:24.0
    command: start-dev --import-realm
    environment:
      KC_HOSTNAME_STRICT: "false"
      KC_HTTP_ENABLED: "true"
      KC_HTTP_PORT: 8180
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: admin
    volumes:
      - ./keycloak/realm-export.json:/opt/keycloak/data/import/realm-export.json:ro
    ports:
      - "18180:8180"

  token-exchange-svc:
    build: .
    environment:
      DIGIT_USER_HOST: http://host.docker.internal:8107
      DIGIT_SYSTEM_USERNAME: INTERNAL_MICROSERVICE_ROLE
      DIGIT_SYSTEM_PASSWORD: eGov@123
      DIGIT_SYSTEM_TENANT: pg
      DIGIT_DEFAULT_TENANT: pg.citya
      KEYCLOAK_ISSUER: http://keycloak:8180/realms/digit-sandbox
      KEYCLOAK_JWKS_URI: http://keycloak:8180/realms/digit-sandbox/protocol/openid-connect/certs
      REDIS_HOST: redis
      REDIS_PORT: 6379
    ports:
      - "18200:3000"
    depends_on:
      - redis
      - keycloak
```

**Step 3: Create docker-compose.test.yml (test deps only)**

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

**Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml docker-compose.test.yml
git commit -m "chore: Dockerfile and Docker Compose for full stack and test deps"
```

---

### Task 10: Keycloak Realm Config + README + Design Doc

**Files:**
- Create: `keycloak/realm-export.json`
- Create: `README.md`
- Copy: `docs/plans/2026-03-05-keycloak-acl-design.md`

**Step 1: Create minimal Keycloak realm export**

`keycloak/realm-export.json` — digit-sandbox realm with registration enabled, email as username, a public client, and 15-minute access tokens.

This is a standard Keycloak realm export JSON. Key settings:
- `realm: "digit-sandbox"`
- `registrationAllowed: true`
- `loginWithEmailAllowed: true`
- `duplicateEmailsAllowed: false`
- Client `digit-sandbox-ui`: public, PKCE, redirect URIs `["http://localhost:*", "https://*.egov.theflywheel.in/*"]`
- Access token lifespan: 900 (15 minutes)
- Refresh token lifespan: 604800 (7 days)
- Password policy: `length(8)`

**Step 2: Create README.md**

Cover: what this repo is, how to run tests, how to integrate with DIGIT tilt-demo, architecture diagram link (gist).

**Step 3: Copy design doc from tilt-demo**

```bash
cp /root/code/tilt-demo/docs/plans/2026-03-05-keycloak-acl-design.md /root/DIGIT-keycloak-overlay/docs/plans/
```

**Step 4: Commit and push**

```bash
git add -A
git commit -m "docs: Keycloak realm config, README, and design doc"
git push -u origin main
```

---

## Test Summary

| Test File | Tests | What It Covers |
|-----------|-------|----------------|
| `tests/unit/jwt.test.ts` | 6 | Valid JWT, missing header, non-Bearer, expired, missing email, garbage |
| `tests/unit/cache.test.ts` | 4 | Cache miss, set/get, delete, tenant scoping |
| `tests/unit/user-resolver.test.ts` | 5 | Provision new user, cache hit, find existing, name sync, tenant scope |
| `tests/unit/routes.test.ts` | 4 | Path mapping, unknown path, empty path |
| `tests/e2e/auth-flow.test.ts` | 3 | Full happy path, no auth header, expired JWT |
| `tests/e2e/user-provision.test.ts` | 2 | New user creation, unique mobile numbers |
| `tests/e2e/cache-behavior.test.ts` | 2 | Second request from cache, pre-populated cache |
| `tests/e2e/user-sync.test.ts` | 1 | Name change sync from JWT to DIGIT |
| `tests/e2e/error-handling.test.ts` | 2 | Garbage token, unknown upstream |
| `tests/e2e/health.test.ts` | 1 | Health endpoint returns ok |
| **Total** | **30** | |

## Running Tests

```bash
# Start Redis (if not running)
docker compose -f docker-compose.test.yml up -d

# Run all tests
npm test

# Run only unit tests
npx vitest run tests/unit/

# Run only E2E tests
npx vitest run tests/e2e/
```
