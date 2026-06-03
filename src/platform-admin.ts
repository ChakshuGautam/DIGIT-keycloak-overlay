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

  // POST /platform-admin/scoped-admins/_invite
  //   God-only. Same as _create but does NOT generate a password.
  //   Instead it:
  //     1. Creates the KC user with the invitee's email (username defaults
  //        to email, can be overridden).
  //     2. Assigns the bootstrap:<tenantId> role.
  //     3. Triggers KC's executeActionsEmail to send the invitee a link
  //        with UPDATE_PASSWORD + VERIFY_EMAIL actions. After they click
  //        through, KC redirects to redirect_uri (the SPA's /admin/login
  //        with the email pre-filled).
  //
  //   Body: { tenantId, email, firstName?, lastName?, redirectUri? }
  //   Returns: { username, email, tenantId, role, inviteSent, expiresAt }
  app.post("/platform-admin/scoped-admins/_invite", async (req, res) => {
    const scope = await resolveAuthScope(req);
    if ("status" in scope) return res.status(scope.status).json(scope.body);
    if (scope.kind !== "god") {
      return res.status(403).json({
        error: "forbidden",
        message:
          "Inviting scoped admins requires god-mode platform admin.",
      });
    }

    const tenantId = String(req.body?.tenantId || "").trim();
    const email = String(req.body?.email || "").trim();
    if (!tenantId || !email) {
      return res.status(400).json({
        error: "bad_request",
        message: "tenantId and email are required.",
      });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "bad_request",
        message: `Invalid email: ${email}`,
      });
    }

    // Username defaults to email — KC allows it, and it matches the
    // single-credential model invitees expect (they log in with their
    // email, not a generated handle).
    const username =
      String(req.body?.username || "").trim() || email.toLowerCase();
    // KC realm enables a person-name validator with regex along the lines
    // of `^[\p{L}\p{M}*+ '-]+$` — letters, marks, spaces, hyphens,
    // apostrophes only. Dots, parens, digits etc. trigger 400 from KC.
    // So defaults must stay within that alphabet; tenant ids carry dots
    // and digits and CANNOT go into firstName/lastName directly.
    const firstName = String(req.body?.firstName || "").trim() || "Tenant";
    const lastName = String(req.body?.lastName || "").trim() || "Admin";
    const roleName = `${SCOPED_ROLE_PREFIX}${tenantId}`;

    // Where the invitee lands after completing UPDATE_PASSWORD. Caller
    // may override; default matches the digit-ui-v2 SPA at the citizen
    // basename — its admin pages mount under /citizen/admin/* because
    // that SPA's <BrowserRouter basename="/citizen">. Override via
    // OVERLAY_ADMIN_REDIRECT_BASE env if your SPA is mounted elsewhere.
    const adminBase =
      process.env.OVERLAY_ADMIN_REDIRECT_BASE ||
      `${(req.headers["x-forwarded-proto"] || "https")}://${req.headers["x-forwarded-host"] || req.headers["host"]}/citizen/admin`;
    // No query string in the redirect — KC's URI allowlist matching is
    // strict about query patterns (?* wildcards don't reliably work
    // across KC versions). The invited=true / email hints are passed via
    // the URL hash instead, which KC doesn't validate and the SPA can
    // read on mount.
    const inviteRedirectUri =
      String(req.body?.redirectUri || "").trim() || `${adminBase}/login`;

    // KC's executeActionsEmail link TTL (seconds). 12h is enough for an
    // invitee to find the email in another tab without re-sending.
    const inviteLifespanSec = 12 * 60 * 60;

    try {
      // 1. Create the user — no `credentials`, no password. KC marks the
      //    account `enabled` but unauthenticated until the actions are
      //    completed. Idempotent (409 = already exists, we'll just
      //    re-trigger the email).
      const createResp = await kcAdminFetch(
        `/admin/realms/${PLATFORM_ADMIN_REALM}/users`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            email,
            firstName,
            lastName,
            enabled: true,
            emailVerified: false,
            // Mark UPDATE_PASSWORD as a required action — even if the
            // user somehow bypasses the email link, KC will force a
            // password set on first login.
            requiredActions: ["UPDATE_PASSWORD"],
          }),
        },
      );
      const created = createResp.status === 201;
      if (!createResp.ok && createResp.status !== 409) {
        throw new Error(
          `user create failed: ${createResp.status} ${await createResp.text()}`,
        );
      }

      // 2. Resolve user id
      const lookup = await kcAdminFetch(
        `/admin/realms/${PLATFORM_ADMIN_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
      );
      const users = (await lookup.json()) as Array<{ id: string }>;
      if (!users[0]) throw new Error(`user lookup returned no rows for ${username}`);
      const userId = users[0].id;

      // 3. Find-or-create the bootstrap:<tenantId> role and assign
      const role = await findOrCreateScopedRole(
        PLATFORM_ADMIN_REALM,
        roleName,
        `Allows holder to bootstrap tenant ${tenantId} via the platform-admin gateway.`,
      );
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

      // 4. Trigger the invite email. KC composes the email using the
      //    realm's SMTP config and the email template
      //    (login/email/executeActions.ftl). The link carries an action
      //    token that's valid for `lifespan` seconds.
      //
      //    `client_id` + `redirect_uri` together tell KC where to send
      //    the user after they complete the required actions. The
      //    redirect_uri MUST be in the client's allowlist or KC will
      //    silently drop it and use the client's baseUrl instead.
      const actionParams = new URLSearchParams({
        lifespan: String(inviteLifespanSec),
        client_id: "admin-cli",
        redirect_uri: inviteRedirectUri,
      });
      const sendEmail = await kcAdminFetch(
        `/admin/realms/${PLATFORM_ADMIN_REALM}/users/${userId}/execute-actions-email?${actionParams.toString()}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(["UPDATE_PASSWORD"]),
        },
      );
      if (!sendEmail.ok) {
        // The user + role exist regardless. Returning 5xx would leave the
        // caller unsure whether to retry; instead return 200 with
        // inviteSent: false so they can resend explicitly.
        const errBody = await sendEmail.text();
        console.error(
          `[PLATFORM-ADMIN] scoped-admin _invite — executeActionsEmail failed for ${email}: ${sendEmail.status} ${errBody}`,
        );
        return res.status(200).json({
          username,
          email,
          tenantId,
          role: roleName,
          realm: PLATFORM_ADMIN_REALM,
          created,
          inviteSent: false,
          inviteError: `KC executeActionsEmail returned ${sendEmail.status}: ${errBody.slice(0, 200)}`,
          hint: "Most common cause: realm SMTP not configured. Set master realm smtpServer.* (host, port, user, password, from).",
        });
      }

      console.log(
        `[PLATFORM-ADMIN] scoped-admin _invite username=${username} email=${email} tenantId=${tenantId} role=${roleName} created=${created} inviteSent=true`,
      );
      res.status(created ? 201 : 200).json({
        username,
        email,
        tenantId,
        role: roleName,
        realm: PLATFORM_ADMIN_REALM,
        created,
        inviteSent: true,
        expiresAt: new Date(Date.now() + inviteLifespanSec * 1000).toISOString(),
        redirectUri: inviteRedirectUri,
      });
    } catch (err) {
      console.error(
        `[PLATFORM-ADMIN] scoped-admin _invite failed for tenantId=${tenantId} email=${email}:`,
        (err as Error).message,
      );
      res.status(500).json({
        error: "internal_error",
        message: (err as Error).message,
      });
    }
  });

  // GET /platform-admin/scoped-admins
  //   God-only. List all scoped admin accounts (users with any
  //   bootstrap:<tenantId> role). For the SPA dashboard.
  app.get("/platform-admin/scoped-admins", async (req, res) => {
    const scope = await resolveAuthScope(req);
    if ("status" in scope) return res.status(scope.status).json(scope.body);
    if (scope.kind !== "god") {
      return res.status(403).json({
        error: "forbidden",
        message: "Listing scoped admins requires god-mode platform admin.",
      });
    }

    try {
      // KC has no native "users by role" search. We fetch all roles whose
      // name starts with `bootstrap:`, then for each role fetch the
      // members, then merge.
      const rolesResp = await kcAdminFetch(
        `/admin/realms/${PLATFORM_ADMIN_REALM}/roles?search=${encodeURIComponent(SCOPED_ROLE_PREFIX)}&first=0&max=200`,
      );
      const allRoles = (await rolesResp.json()) as Array<{ name: string }>;
      const scopedRoles = allRoles.filter((r) =>
        r.name.startsWith(SCOPED_ROLE_PREFIX),
      );

      const out: Array<{
        username: string;
        email: string;
        tenantId: string;
        role: string;
        emailVerified: boolean;
        requiredActions: string[];
        createdTimestamp?: number;
      }> = [];

      for (const role of scopedRoles) {
        const tenantId = role.name.slice(SCOPED_ROLE_PREFIX.length);
        const usersResp = await kcAdminFetch(
          `/admin/realms/${PLATFORM_ADMIN_REALM}/roles/${encodeURIComponent(role.name)}/users`,
        );
        if (!usersResp.ok) continue;
        const users = (await usersResp.json()) as Array<{
          username: string;
          email?: string;
          emailVerified?: boolean;
          requiredActions?: string[];
          createdTimestamp?: number;
        }>;
        for (const u of users) {
          out.push({
            username: u.username,
            email: u.email || "",
            tenantId,
            role: role.name,
            emailVerified: !!u.emailVerified,
            requiredActions: u.requiredActions || [],
            createdTimestamp: u.createdTimestamp,
          });
        }
      }

      // Newest first; same email may appear once per tenant they admin.
      out.sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0));
      res.json({ count: out.length, scopedAdmins: out });
    } catch (err) {
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

    // Auto-_generatekey for tenant_bootstrap on a NEW root tenant.
    //
    // When MCP's tenant_bootstrap reaches its admin-user-create step,
    // egov-user calls egov-enc-service to encrypt the new admin's PII.
    // For a brand-new state root (one not under any existing root's
    // tenant.tenants list), enc-service has no key and 500s
    // "Tenant Id not found", which surfaces in the bootstrap response as
    // adminUser.provisioned=false. The wizard then looks broken even
    // though most of the bootstrap (schemas, MDMS data, localizations)
    // succeeded.
    //
    // Fix transparently: before forwarding the bootstrap, POST to
    // enc-service /crypto/v1/_generatekey for the target tenant. The
    // endpoint is idempotent (returns the existing keyId for known
    // tenants), so this is safe for sub-tenants too. Failure is
    // logged but NOT fatal — the bootstrap may still succeed if the
    // tenant has a key via some other path (e.g. it was pre-seeded).
    if (
      req.method === "POST" &&
      upstreamPath === "/v1/tenant/bootstrap" &&
      req.body?.target_tenant
    ) {
      const encUrl =
        process.env.DIGIT_ENC_SERVICE_URL ||
        `${config.digitGatewayHost}/egov-enc-service`;
      try {
        const gen = await fetch(`${encUrl}/crypto/v1/_generatekey`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId: req.body.target_tenant }),
        });
        if (gen.ok) {
          const g = await gen.json();
          console.log(
            `[PLATFORM-ADMIN] auto _generatekey for ${req.body.target_tenant}: created=${g.created} keyId=${g.keyId}`,
          );
        } else if (gen.status === 404) {
          // enc-service doesn't have _generatekey deployed yet — log
          // once and proceed. Operators with an older enc-service
          // image will see admin-user provisioning fail for new roots
          // and know to upgrade.
          console.warn(
            `[PLATFORM-ADMIN] _generatekey endpoint missing on enc-service (404). ` +
              `Bootstrap of a brand-new root will fail at admin-user create. ` +
              `Upgrade egov-enc-service to a build that includes the endpoint.`,
          );
        } else {
          console.warn(
            `[PLATFORM-ADMIN] _generatekey for ${req.body.target_tenant} returned ${gen.status} — proceeding anyway`,
          );
        }
      } catch (err) {
        console.warn(
          `[PLATFORM-ADMIN] _generatekey for ${req.body.target_tenant} threw — proceeding anyway:`,
          (err as Error).message,
        );
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
