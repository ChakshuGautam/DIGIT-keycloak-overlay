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
  ) {
    this.gatewayUrl = this.config.get<string>("DIGIT_GATEWAY_HOST") ?? "http://kong-gateway:8000";
    this.defaultTenant = this.config.get<string>("DIGIT_DEFAULT_TENANT") ?? "pg.citya";
  }

  @All("*")
  async handleAll(@Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
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
    const path = req.url; // includes query string
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
      await this.forwardToGateway(req, res);
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
      await this.proxyRequest(req, res, user, token);
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
  ): Promise<void> {
    const upstreamUrl = `${this.gatewayUrl}${req.url}`;
    const contentType = (req.headers["content-type"] as string) || "";

    try {
      if (contentType.includes("application/json")) {
        // JSON: rewrite RequestInfo in body (v1 behavior: userInfo = full digitUser object)
        const body = (req.body as any) || {};
        body.RequestInfo = body.RequestInfo || {};
        body.RequestInfo.authToken = citizenToken;
        body.RequestInfo.userInfo = digitUser;

        const upstreamResp = await fetch(upstreamUrl, {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        res.status(upstreamResp.status);
        const ct = upstreamResp.headers.get("content-type");
        if (ct) res.header("Content-Type", ct);
        res.send(await upstreamResp.text());
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
   * Forward unchanged to gateway — matches v1's forwardToGateway() exactly.
   */
  private async forwardToGateway(req: FastifyRequest, res: FastifyReply): Promise<void> {
    // KC OIDC endpoints should go to Keycloak, not Kong
    const kcUrl = this.config.get<string>("KEYCLOAK_INTERNAL_URL") || "http://keycloak:8080";
    const isKcPath = req.url.startsWith("/realms/");
    const upstreamUrl = isKcPath
      ? `${kcUrl}${req.url}`
      : `${this.gatewayUrl}${req.url}`;

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
