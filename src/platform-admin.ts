/**
 * Platform admin gateway: gates DIGIT-MCP's /v1/* + /mcp REST surface behind
 * a Keycloak JWT with a platform-admin claim, and lets the platform admin
 * delegate scoped bootstrap rights to per-tenant admins.
 *
 * Two personas:
 *   (1) GOD ADMIN  — built-in master-realm admin OR any master-realm user
 *                    holding the PLATFORM_ADMIN role. Can call ANY /v1/*
 *                    endpoint against ANY tenant. The provisioning side
 *                    of this gateway (creating scoped admins) is also
 *                    god-mode-only.
 *   (2) SCOPED ADMIN — master-realm user holding a `bootstrap:<tenantId>`
 *                    role. Can call tenant_bootstrap (and the closely-
 *                    related tenant ops) ONLY when the request's target
 *                    tenant matches the role's tenant. Anything else
 *                    returns 403.
 *
 * Routes (mounted under /platform-admin/* on the overlay):
 *
 *   God-only:
 *     POST /platform-admin/scoped-admins/_create
 *       body: { tenantId, username?, password? }
 *       returns: { username, password, tenantId, role }
 *
 *   God or matching-scoped:
 *     POST /platform-admin/v1/tenant/bootstrap   (scope-checked)
 *     POST /platform-admin/v1/tenant/city        (scope-checked)
 *     POST /platform-admin/v1/tenant/cleanup     (scope-checked)
 *
 *   God-only (full MCP surface — everything else under /v1/* and /mcp):
 *     ANY  /platform-admin/v1/*
 *     POST /platform-admin/mcp
 *
 * Public URL on Bomet:
 *   https://bometfeedbackhub.digit.org/token-exchange/platform-admin/...
 */
import type { Request, Response as ExpressResponse, Express } from "express";
import { validateJwt } from "./jwt.js";
import { config } from "./config.js";
import { getAdminToken } from "./keycloak-admin.js";

// MCP HTTP transport address inside the container network. Override via env
// for non-standard deployments. Default matches the compose service name +
// container port (digit-mcp:3000, not the host-exposed 13101).
const MCP_BASE_URL = process.env.MCP_BASE_URL || "http://digit-mcp:3000";

// Which KC realm holds platform-admin accounts. KC's `master` realm has
// cross-realm authority by design; aligning platform-admin to it gives us
// "one identity boundary, all realms" without inventing a new realm.
const PLATFORM_ADMIN_REALM =
  process.env.KEYCLOAK_PLATFORM_ADMIN_REALM || "master";

// Role name for the god-tier platform admin. The built-in master admin
// (username=admin) is recognized implicitly; this is for additional users
// who should also get god mode.
const GOD_ROLE = "PLATFORM_ADMIN";

// Prefix for scoped delegation roles. Example: `bootstrap:ke.kisumu` lets
// the holder call tenant_bootstrap for tenant `ke.kisumu` ONLY.
const SCOPED_ROLE_PREFIX = "bootstrap:";

type AuthScope =
  | { kind: "god"; sub: string; preferred_username: string }
  | { kind: "scoped"; sub: string; preferred_username: string; tenantId: string };

interface ScopeError {
  status: number;
  body: Record<string, unknown>;
}

async function resolveAuthScope(req: Request): Promise<AuthScope | ScopeError> {
  const claims = await validateJwt(req.headers.authorization).catch(() => null);
  if (!claims) {
    return {
      status: 401,
      body: {
        error: "unauthorized",
        message:
          "Missing or invalid Keycloak JWT in Authorization header. Mint one via " +
          `POST /realms/${PLATFORM_ADMIN_REALM}/protocol/openid-connect/token.`,
      },
    };
  }
  if (claims.realm !== PLATFORM_ADMIN_REALM) {
    return {
      status: 403,
      body: {
        error: "forbidden",
        message:
          `Platform-admin endpoints require a JWT from the "${PLATFORM_ADMIN_REALM}" realm. ` +
          `Your token is from "${claims.realm}".`,
        tokenRealm: claims.realm,
      },
    };
  }

  const roles = claims.realm_access?.roles || [];
  const preferred = claims.preferred_username || "";

  // GOD: built-in master admin (preferred_username=admin) OR explicit role
  if (preferred === "admin" || roles.includes(GOD_ROLE)) {
    return { kind: "god", sub: claims.sub, preferred_username: preferred };
  }

  // SCOPED: bootstrap:<tenantId> role
  const scopedRole = roles.find((r) => r.startsWith(SCOPED_ROLE_PREFIX));
  if (scopedRole) {
    const tenantId = scopedRole.slice(SCOPED_ROLE_PREFIX.length);
    if (!tenantId) {
      return {
        status: 403,
        body: {
          error: "forbidden",
          message: `Malformed scoped role "${scopedRole}" — expected "bootstrap:<tenantId>".`,
        },
      };
    }
    return {
      kind: "scoped",
      sub: claims.sub,
      preferred_username: preferred,
      tenantId,
    };
  }

  return {
    status: 403,
    body: {
      error: "forbidden",
      message:
        `Platform-admin access requires either the "${GOD_ROLE}" role or a "${SCOPED_ROLE_PREFIX}<tenantId>" role on the JWT.`,
      yourRoles: roles,
    },
  };
}

/**
 * Which scoped admins are allowed to call which MCP endpoints. The path is
 * the MCP path (after stripping /platform-admin). The function returns the
 * tenantId the request is targeting, so we can compare it against the
 * scoped role's tenantId.
 *
 * Anything not listed here is god-only — scoped admins get 403.
 */
function scopedTargetTenant(method: string, mcpPath: string, body: any): string | null {
  if (method !== "POST") return null;
  if (mcpPath === "/v1/tenant/bootstrap") return body?.target_tenant ?? null;
  if (mcpPath === "/v1/tenant/city") return body?.tenant_id ?? null;
  if (mcpPath === "/v1/tenant/cleanup") return body?.target_tenant ?? body?.tenant_id ?? null;
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// KC admin helpers (used by /scoped-admins/_create)
// ────────────────────────────────────────────────────────────────────────

async function kcAdminFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAdminToken();
  return fetch(`${config.keycloakAdminUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

async function findOrCreateScopedRole(
  realm: string,
  roleName: string,
  description: string,
): Promise<{ id: string; name: string }> {
  // Look up first — KC returns 404 if it doesn't exist
  const lookup = await kcAdminFetch(
    `/admin/realms/${realm}/roles/${encodeURIComponent(roleName)}`,
  );
  if (lookup.ok) {
    return (await lookup.json()) as { id: string; name: string };
  }
  if (lookup.status !== 404) {
    throw new Error(`role lookup failed: ${lookup.status} ${await lookup.text()}`);
  }

  // Create the realm role
  const create = await kcAdminFetch(`/admin/realms/${realm}/roles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: roleName, description }),
  });
  if (!create.ok && create.status !== 409) {
    throw new Error(`role create failed: ${create.status} ${await create.text()}`);
  }
  // Re-fetch to get the role's id (needed for the role-mapping POST)
  const after = await kcAdminFetch(
    `/admin/realms/${realm}/roles/${encodeURIComponent(roleName)}`,
  );
  if (!after.ok) {
    throw new Error(`role re-fetch failed: ${after.status} ${await after.text()}`);
  }
  return (await after.json()) as { id: string; name: string };
}

function generatePassword(length = 24): string {
  // base64url over crypto.randomBytes — passes any KC password policy.
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
    .slice(0, length);
}

// ────────────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────────────

export function registerPlatformAdminRoutes(app: Express) {
  // POST /platform-admin/scoped-admins/_create
  //   God-only. Creates a master-realm user with a single bootstrap:<tenantId>
  //   role. Returns the credentials caller should hand to the tenant owner.
  app.post("/platform-admin/scoped-admins/_create", async (req, res) => {
    const scope = await resolveAuthScope(req);
    if ("status" in scope) return res.status(scope.status).json(scope.body);
    if (scope.kind !== "god") {
      return res.status(403).json({
        error: "forbidden",
        message:
          "Creating scoped admins requires god-mode platform admin (PLATFORM_ADMIN role or built-in master admin).",
      });
    }

    const tenantId = String(req.body?.tenantId || "").trim();
    if (!tenantId) {
      return res.status(400).json({
        error: "bad_request",
        message: "tenantId is required (e.g. 'ke.kisumu').",
      });
    }
    const username =
      String(req.body?.username || "").trim() ||
      `bootstrap-${tenantId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const password = String(req.body?.password || "") || generatePassword();
    const roleName = `${SCOPED_ROLE_PREFIX}${tenantId}`;

    try {
      // 1. Create the user (idempotent: 409 = already exists, we'll just
      //    add the role to the existing user).
      const createResp = await kcAdminFetch(
        `/admin/realms/${PLATFORM_ADMIN_REALM}/users`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            enabled: true,
            firstName: "Scoped",
            lastName: tenantId,
            credentials: [
              { type: "password", value: password, temporary: false },
            ],
          }),
        },
      );
      const created = createResp.status === 201;
      if (!createResp.ok && createResp.status !== 409) {
        throw new Error(
          `user create failed: ${createResp.status} ${await createResp.text()}`,
        );
      }

      // 2. Look up the user's id (needed for role mapping)
      const lookup = await kcAdminFetch(
        `/admin/realms/${PLATFORM_ADMIN_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
      );
      const users = (await lookup.json()) as Array<{ id: string }>;
      if (!users[0]) throw new Error(`user lookup returned no rows for ${username}`);
      const userId = users[0].id;

      // 3. Find-or-create the bootstrap:<tenantId> realm role
      const role = await findOrCreateScopedRole(
        PLATFORM_ADMIN_REALM,
        roleName,
        `Allows holder to bootstrap tenant ${tenantId} via the platform-admin gateway.`,
      );

      // 4. Assign the role
      const assign = await kcAdminFetch(
        `/admin/realms/${PLATFORM_ADMIN_REALM}/users/${userId}/role-mappings/realm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([{ id: role.id, name: role.name }]),
        },
      );
      if (!assign.ok && assign.status !== 409) {
        throw new Error(
          `role assign failed: ${assign.status} ${await assign.text()}`,
        );
      }

      // 5. If the user pre-existed, reset their password to the one we
      //    just generated so the caller has a working credential.
      if (!created) {
        await kcAdminFetch(
          `/admin/realms/${PLATFORM_ADMIN_REALM}/users/${userId}/reset-password`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "password",
              value: password,
              temporary: false,
            }),
          },
        );
      }

      console.log(
        `[PLATFORM-ADMIN] scoped-admin _create username=${username} tenantId=${tenantId} role=${roleName} created=${created}`,
      );
      res.status(created ? 201 : 200).json({
        username,
        password,
        tenantId,
        role: roleName,
        realm: PLATFORM_ADMIN_REALM,
        created,
        loginExample: {
          method: "POST",
          url: `/realms/${PLATFORM_ADMIN_REALM}/protocol/openid-connect/token`,
          body: {
            grant_type: "password",
            client_id: "admin-cli",
            username,
            password,
          },
        },
      });
    } catch (err) {
      console.error(
        `[PLATFORM-ADMIN] scoped-admin _create failed for tenantId=${tenantId}:`,
        (err as Error).message,
      );
      res.status(500).json({
        error: "internal_error",
        message: (err as Error).message,
      });
    }
  });

  // ANY /platform-admin/* — proxy to MCP after RBAC check
  app.all("/platform-admin/*", async (req, res) => {
    // Don't double-handle the _create route above. Express matches in
    // registration order, but app.all('*') below would shadow it; the
    // _create route is registered first so it takes precedence.
    const scope = await resolveAuthScope(req);
    if ("status" in scope) return res.status(scope.status).json(scope.body);

    const upstreamPath = req.originalUrl.replace(/^\/platform-admin/, "");

    // Enforce scope for non-god callers: their JWT's tenantId must match
    // the request's target tenant.
    if (scope.kind === "scoped") {
      const target = scopedTargetTenant(req.method, upstreamPath, req.body);
      if (!target) {
        return res.status(403).json({
          error: "forbidden",
          message:
            `Scoped admins (bootstrap:${scope.tenantId}) may only call tenant_bootstrap, ` +
            `tenant/city, or tenant/cleanup. Path ${req.method} ${upstreamPath} requires god-mode.`,
        });
      }
      if (target !== scope.tenantId) {
        return res.status(403).json({
          error: "forbidden",
          message:
            `Scoped admin role is bootstrap:${scope.tenantId}; request targets ${target}. ` +
            `Tenant scope mismatch.`,
        });
      }
    }

    const upstreamUrl = `${MCP_BASE_URL}${upstreamPath}`;
    const upstreamHeaders: Record<string, string> = {
      "Content-Type": req.headers["content-type"] || "application/json",
    };
    if (req.headers["accept"]) {
      upstreamHeaders["Accept"] = String(req.headers["accept"]);
    }
    const wantsStream = /text\/event-stream/.test(
      String(req.headers["accept"] || ""),
    );

    try {
      const upstreamResp = await fetch(upstreamUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body: ["GET", "HEAD"].includes(req.method)
          ? undefined
          : JSON.stringify(req.body ?? {}),
      });

      const ct = upstreamResp.headers.get("content-type") || "";
      const scopeNote =
        scope.kind === "god"
          ? "god"
          : `scoped(${scope.tenantId})`;
      console.log(
        `[PLATFORM-ADMIN] ${req.method} ${req.originalUrl} → MCP ${upstreamResp.status} ` +
          `(user=${scope.preferred_username}, scope=${scopeNote})`,
      );

      if (wantsStream && ct.includes("text/event-stream")) {
        res.status(upstreamResp.status);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        const reader = upstreamResp.body?.getReader();
        if (!reader) {
          res.end();
          return;
        }
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
        res.end();
        return;
      }

      res.status(upstreamResp.status);
      if (ct) res.setHeader("Content-Type", ct);
      const body = await upstreamResp.text();
      res.send(body);
    } catch (err) {
      console.error(
        `[PLATFORM-ADMIN] ${req.method} ${req.originalUrl} — proxy to MCP failed:`,
        (err as Error).message,
      );
      res.status(502).json({
        error: "bad_gateway",
        message: `Failed to reach MCP at ${MCP_BASE_URL}`,
        details: (err as Error).message,
      });
    }
  });
}
