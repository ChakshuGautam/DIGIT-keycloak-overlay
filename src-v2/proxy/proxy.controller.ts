import {
  Controller,
  All,
  Req,
  Res,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyRequest, FastifyReply } from "fastify";
import { JwtService } from "../auth/jwt.service";
import { UserResolverService } from "../user/user-resolver.service";
import { CacheService } from "../cache/cache.service";
import { MetricsService } from "../metrics/metrics.service";
import { KcAdminService } from "../keycloak/kc-admin.service";
import type { DigitUser } from "../types";

@Controller()
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);
  private readonly gatewayUrl: string;
  private readonly defaultTenant: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly userResolver: UserResolverService,
    private readonly cache: CacheService,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
    private readonly kcAdmin: KcAdminService,
  ) {
    this.gatewayUrl = this.config.get<string>("DIGIT_GATEWAY_HOST") ?? "http://kong-gateway:8000";
    this.defaultTenant = this.config.get<string>("DIGIT_DEFAULT_TENANT") ?? "pg.citya";
  }

  @All("*")
  async handleAll(@Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    // Fix HRMS / boundary-service search NPE: add default offset/limit and tenantId if missing
    let requestUrl = req.url;
    if (
      (requestUrl.includes('/egov-hrms/') || requestUrl.includes('/boundary-service/')) &&
      (requestUrl.includes('_search') || requestUrl.includes('_count'))
    ) {
      const url = new URL(requestUrl, 'http://localhost');
      if (!url.searchParams.has('offset')) url.searchParams.set('offset', '0');
      if (!url.searchParams.has('limit')) url.searchParams.set('limit', '100');
      // HRMS requires tenantId as query param — extract from body if missing
      if (!url.searchParams.has('tenantId')) {
        const body = (req.body as any) || {};
        const tenantId = body.criteria?.tenantId || body.tenantId || this.defaultTenant;
        url.searchParams.set('tenantId', tenantId);
      }
      // Boundary service requires boundaryType for relationship searches
      if (requestUrl.includes('/boundary-service/') && requestUrl.includes('boundary-relationships') && !url.searchParams.has('boundaryType')) {
        url.searchParams.set('boundaryType', 'City');
      }
      requestUrl = url.pathname + url.search;
    }

    // CORS
    const origin = req.headers["origin"] as string;
    const allowedOrigins = this.config.get<string>("CORS_ALLOWED_ORIGINS");
    if (!allowedOrigins || (origin && allowedOrigins.split(",").map(s => s.trim()).includes(origin))) {
      res.header("Access-Control-Allow-Origin", origin || "*");
    } else if (!allowedOrigins) {
      res.header("Access-Control-Allow-Origin", "*");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      res.status(204).send();
      return;
    }

    const method = req.method;
    const path = requestUrl; // includes query string (may have HRMS offset/limit added)
    const body = (req.body as any) || {};

    // Try Authorization header, then RequestInfo.authToken
    let jwtToken = req.headers["authorization"] as string | undefined;
    if (!jwtToken && body.RequestInfo?.authToken) {
      jwtToken = `Bearer ${body.RequestInfo.authToken}`;
    }

    const claims = await this.jwt.validate(jwtToken).catch(() => null);

    if (!claims) {
      // No KC JWT — forward to gateway unchanged (like v1's forwardToGateway)
      this.metrics.jwtValidationTotal.inc({ result: "missing" });
      await this.forwardToGateway(req, res, requestUrl);
      return;
    }

    this.metrics.jwtValidationTotal.inc({ result: "success" });

    // Determine tenantId (same priority as v1)
    const tenantId =
      body.RequestInfo?.userInfo?.tenantId ||
      body.tenantId ||
      this.defaultTenant;

    try {
      const { user, token } = await this.userResolver.resolve(claims, tenantId);
      // Proxy to gateway with rewritten RequestInfo (matching v1 exactly)
      await this.proxyRequest(req, res, user, token, requestUrl);
    } catch (err) {
      this.logger.error(`Proxy error: ${(err as Error).message}`);
      res.status(500).send({ error: "Internal error", message: "Failed to resolve user" });
    }
  }

  /**
   * Proxy with KC user — matches v1's proxyRequest() exactly.
   * Routes through Kong gateway (not direct to upstream).
   * Rewrites RequestInfo.authToken + userInfo.
   */
  private async proxyRequest(
    req: FastifyRequest,
    res: FastifyReply,
    digitUser: DigitUser,
    citizenToken: string,
    url?: string,
  ): Promise<void> {
    let upstreamUrl = `${this.gatewayUrl}${url || req.url}`;
    const contentType = (req.headers["content-type"] as string) || "";

    try {
      if (contentType.includes("application/json")) {
        // JSON: rewrite RequestInfo in body (v1 behavior: userInfo = full digitUser object)
        const body = (req.body as any) || {};
        body.RequestInfo = body.RequestInfo || {};
        body.RequestInfo.authToken = citizenToken;
        body.RequestInfo.userInfo = digitUser;

        // Inject search criteria for endpoints that need it from userInfo
        const effectiveUrl = url || req.url;
        if (effectiveUrl.includes('/user/_search') && !body.uuid && !body.userName) {
          body.uuid = [digitUser.uuid];
          body.tenantId = digitUser.tenantId;
        }
        // egov-user-event uses @ModelAttribute — userids must be a query param, not body
        // For CITIZEN users it auto-populates from userInfo, but for EMPLOYEE it's required
        if (effectiveUrl.includes('/egov-user-event/') && !effectiveUrl.includes('userids=')) {
          const separator = effectiveUrl.includes('?') ? '&' : '?';
          upstreamUrl = upstreamUrl + separator + 'userids=' + digitUser.uuid;
        }

        const upstreamResp = await fetch(upstreamUrl, {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const responseBody = await upstreamResp.text();

        // After successful HRMS employee creation, sync user to Keycloak
        if (req.url.includes('/egov-hrms/employees/_create') && upstreamResp.status === 200) {
          try {
            const data = JSON.parse(responseBody);
            const employees = data.Employees || [];
            for (const emp of employees) {
              const user = emp.user;
              if (user && user.emailId && this.kcAdmin.hasAdminToken()) {
                this.createKcUserForEmployee(user).catch(err =>
                  this.logger.warn(`KC user sync failed for ${user.emailId}: ${(err as Error).message}`),
                );
              }
            }
          } catch { /* ignore parse errors */ }
        }

        res.status(upstreamResp.status);
        const ct = upstreamResp.headers.get("content-type");
        if (ct) res.header("Content-Type", ct);
        res.send(responseBody);
      } else if (contentType.includes("multipart/form-data")) {
        // Multipart: pass token via query param
        const url = new URL(upstreamUrl);
        url.searchParams.set("auth-token", citizenToken);

        const upstreamResp = await fetch(url.toString(), {
          method: req.method,
          headers: {
            "Content-Type": contentType,
          },
          body: req.raw as any,
          // @ts-expect-error duplex is valid
          duplex: "half",
        });

        res.status(upstreamResp.status);
        const ct = upstreamResp.headers.get("content-type");
        if (ct) res.header("Content-Type", ct);
        res.send(await upstreamResp.text());
      } else {
        // Unknown content type: pass-through with auth header
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string" && !["host", "connection"].includes(k)) {
            headers[k] = v;
          }
        }
        headers["Authorization"] = `Bearer ${citizenToken}`;

        const upstreamResp = await fetch(upstreamUrl, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : (req.raw as any),
          // @ts-expect-error duplex is valid
          duplex: "half",
        });

        res.status(upstreamResp.status);
        const ct = upstreamResp.headers.get("content-type");
        if (ct) res.header("Content-Type", ct);
        res.send(await upstreamResp.text());
      }
    } catch (err) {
      this.logger.error(`Upstream error: ${(err as Error).message}`);
      res.status(502).send({ error: "Bad gateway", details: String(err) });
    }
  }

  /**
   * Create a Keycloak user corresponding to an HRMS-created DIGIT employee.
   * Fire-and-forget: failures are logged but do not block the response.
   */
  private async createKcUserForEmployee(user: {
    emailId: string;
    name?: string;
    userName?: string;
    roles?: Array<{ code: string; name: string }>;
  }): Promise<void> {
    const realm = this.config.get<string>("KEYCLOAK_USER_REALM");
    if (!realm) {
      this.logger.warn("KEYCLOAK_USER_REALM not configured — skipping KC user sync");
      return;
    }

    const kcAdminUrl = this.config.get<string>("KEYCLOAK_ADMIN_URL") || "http://localhost:8180";
    const token = this.kcAdmin.getAdminToken();

    // Create user in KC
    const kcUser = {
      username: user.emailId,
      email: user.emailId,
      firstName: user.name?.split(" ")[0] || user.emailId,
      lastName: user.name?.split(" ").slice(1).join(" ") || "",
      enabled: true,
      emailVerified: true,
      credentials: [
        {
          type: "password",
          value: "eGov@123",
          temporary: true,
        },
      ],
    };

    const createResp = await fetch(`${kcAdminUrl}/admin/realms/${realm}/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(kcUser),
    });

    if (createResp.status === 409) {
      this.logger.log(`KC user already exists for ${user.emailId}`);
      return;
    }

    if (!createResp.ok) {
      const text = await createResp.text().catch(() => "");
      throw new Error(`KC user create failed: ${createResp.status} ${text}`);
    }

    this.logger.log(`KC user created for employee ${user.emailId}`);

    // Assign DIGIT roles if present
    const roleCodes = user.roles?.map(r => r.code).filter(Boolean) || [];
    if (roleCodes.length > 0) {
      // Get KC user ID from Location header
      const location = createResp.headers.get("Location") || "";
      const kcUserId = location.split("/").pop();
      if (kcUserId) {
        await this.kcAdmin.assignRealmRoles(realm, kcUserId, roleCodes).catch(err =>
          this.logger.warn(`KC role assignment failed for ${user.emailId}: ${(err as Error).message}`),
        );
      }
    }
  }

  /**
   * Forward unchanged to gateway — matches v1's forwardToGateway() exactly.
   */
  private async forwardToGateway(req: FastifyRequest, res: FastifyReply, url?: string): Promise<void> {
    // KC OIDC endpoints should go to Keycloak, not Kong
    const kcUrl = this.config.get<string>("KEYCLOAK_INTERNAL_URL") || "http://keycloak:8080";
    const effectiveUrl = url || req.url;
    const isKcPath = effectiveUrl.startsWith("/realms/");
    const upstreamUrl = isKcPath
      ? `${kcUrl}${effectiveUrl}`
      : `${this.gatewayUrl}${effectiveUrl}`;

    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && !["host", "connection"].includes(k)) {
          headers[k] = v;
        }
      }

      const contentType = (req.headers["content-type"] as string) || "";
      let body: string | undefined;
      if (!["GET", "HEAD"].includes(req.method)) {
        if (contentType.includes("application/json") && req.body) {
          body = JSON.stringify(req.body);
        } else if (contentType.includes("x-www-form-urlencoded") && req.body) {
          // Fastify parses form data into object — re-serialize as URLSearchParams
          body = new URLSearchParams(req.body as any).toString();
        }
      }

      const upstreamResp = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
      });

      res.status(upstreamResp.status);
      const ct = upstreamResp.headers.get("content-type");
      if (ct) res.header("Content-Type", ct);
      res.send(await upstreamResp.text());
    } catch (err) {
      this.logger.error(`Gateway error: ${(err as Error).message}`);
      res.status(502).send({ error: "Bad gateway", details: String(err) });
    }
  }
}
