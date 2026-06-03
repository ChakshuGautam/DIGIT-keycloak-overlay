/**
 * Platform admin proxy: gates DIGIT-MCP's /v1/* + /mcp REST surface behind a
 * master-realm Keycloak JWT.
 *
 * The MCP server itself ships unauthenticated (it expects to be behind a
 * trust boundary). We make the overlay that boundary: ONE role — Keycloak
 * `master` realm membership — grants access to ALL platform-admin ops
 * (tenant_bootstrap, mdms_create, user_create, …). Anything else gets 403.
 *
 * Routes (mounted under /platform-admin/* on the overlay):
 *   GET  /platform-admin/v1/version         → MCP /v1/version
 *   POST /platform-admin/v1/tenant/bootstrap → MCP /v1/tenant/bootstrap
 *   POST /platform-admin/v1/tenant/city      → MCP /v1/tenant/city
 *   …any /v1/* path MCP exposes…
 *   POST /platform-admin/mcp                 → MCP /mcp (JSON-RPC)
 *
 * Public URL on Bomet:
 *   https://bometfeedbackhub.digit.org/token-exchange/platform-admin/v1/tenant/bootstrap
 */
import type { Request, Response } from "express";
import { validateJwt } from "./jwt.js";

// MCP HTTP transport address inside the container network. Override via env
// for non-standard deployments. Default matches the compose service name +
// container port (digit-mcp:3000, not the host-exposed 13101).
const MCP_BASE_URL = process.env.MCP_BASE_URL || "http://digit-mcp:3000";

// Which KC realm grants platform-admin access. KC's `master` realm has
// cross-realm authority by design; aligning platform-admin to it gives us
// "one account, all realms" without inventing a new role system. Override
// via env (e.g. KEYCLOAK_PLATFORM_ADMIN_REALM=platform) if you want a
// dedicated realm rather than KC's built-in master.
const PLATFORM_ADMIN_REALM =
  process.env.KEYCLOAK_PLATFORM_ADMIN_REALM || "master";

interface AuthContext {
  sub: string;
  realm: string;
  email: string;
}

async function requireMasterRealmJwt(
  req: Request,
  res: Response,
): Promise<AuthContext | null> {
  const claims = await validateJwt(req.headers.authorization).catch(() => null);
  if (!claims) {
    res.status(401).json({
      error: "unauthorized",
      message:
        "Missing or invalid Keycloak JWT in Authorization header. Mint one via " +
        `POST /realms/${PLATFORM_ADMIN_REALM}/protocol/openid-connect/token.`,
    });
    return null;
  }
  if (claims.realm !== PLATFORM_ADMIN_REALM) {
    res.status(403).json({
      error: "forbidden",
      message:
        `Platform-admin endpoints require a JWT from the "${PLATFORM_ADMIN_REALM}" realm. ` +
        `Your token is from "${claims.realm}".`,
      tokenRealm: claims.realm,
    });
    return null;
  }
  return { sub: claims.sub, realm: claims.realm, email: claims.email };
}

export function registerPlatformAdminRoutes(app: import("express").Express) {
  // Catch every method under /platform-admin/*. We forward to MCP preserving
  // method, body, query, and (for SSE) the Accept header — MCP's bootstrap
  // endpoint streams progress when Accept: text/event-stream.
  app.all("/platform-admin/*", async (req, res) => {
    const ctx = await requireMasterRealmJwt(req, res);
    if (!ctx) return;

    // Strip the /platform-admin prefix; everything else (including /v1/*
    // and /mcp) is passed through to MCP verbatim.
    const upstreamPath = req.originalUrl.replace(/^\/platform-admin/, "");
    const upstreamUrl = `${MCP_BASE_URL}${upstreamPath}`;

    const upstreamHeaders: Record<string, string> = {
      "Content-Type": req.headers["content-type"] || "application/json",
    };
    // MCP's JSON-RPC requires Accept to include both content types.
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
      console.log(
        `[PLATFORM-ADMIN] ${req.method} ${req.originalUrl} → MCP ${upstreamResp.status} ` +
          `(realm=${ctx.realm}, sub=${ctx.sub})`,
      );

      // SSE passthrough — MCP streams progress for long bootstrap runs.
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

      // Normal JSON / text passthrough.
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
