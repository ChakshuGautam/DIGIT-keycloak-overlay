import {
  Controller,
  All,
  Req,
  Res,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyRequest, FastifyReply } from "fastify";
import { ProxyService } from "./proxy.service";
import { JwtService } from "../auth/jwt.service";
import { UserResolverService } from "../user/user-resolver.service";
import { CacheService } from "../cache/cache.service";
import { MetricsService } from "../metrics/metrics.service";

@Controller()
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);
  private readonly gatewayUrl: string;
  private readonly defaultTenant: string;

  constructor(
    private readonly proxy: ProxyService,
    private readonly jwt: JwtService,
    private readonly userResolver: UserResolverService,
    private readonly cache: CacheService,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {
    this.gatewayUrl =
      this.config.get<string>("KONG_GATEWAY_URL") ?? "http://kong-gateway:8000";
    this.defaultTenant =
      this.config.get<string>("DIGIT_DEFAULT_TENANT") ?? "pg.citya";
  }

  @All("*")
  async handleAll(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    // CORS headers
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

    const path = req.url.split("?")[0];
    const method = req.method;
    const contentType = (req.headers["content-type"] as string) || "";
    const authHeader = req.headers["authorization"] as string | undefined;

    // Try to extract JWT from Authorization header, then fallback to RequestInfo.authToken
    let jwtToken = authHeader;
    const body = (req.body as any) || {};

    if (!jwtToken && body.RequestInfo?.authToken) {
      jwtToken = `Bearer ${body.RequestInfo.authToken}`;
    }

    // Validate JWT
    const claims = await this.jwt.validate(jwtToken);

    if (!claims) {
      // If Authorization header was present but invalid, clear cache best-effort
      if (authHeader) {
        const sub = this.jwt.extractSubFromToken(authHeader);
        if (sub) {
          this.cache.deleteAllForSub(sub).catch(() => {});
        }
      }

      this.metrics.jwtValidationTotal.inc({ result: "invalid" });

      // Forward unchanged to upstream or gateway
      const upstreamUrl =
        this.proxy.resolveUpstreamUrl(path) ?? `${this.gatewayUrl}${path}`;
      await this.forwardAndRespond(method, upstreamUrl, req, res, body);
      return;
    }

    this.metrics.jwtValidationTotal.inc({ result: "valid" });

    // Determine tenantId
    const tenantId =
      body.RequestInfo?.userInfo?.tenantId ||
      body.tenantId ||
      this.defaultTenant;

    try {
      // Resolve DIGIT user
      const { user, token } = await this.userResolver.resolve(claims, tenantId);

      // Determine upstream URL
      const upstreamUrl =
        this.proxy.resolveUpstreamUrl(path) ?? `${this.gatewayUrl}${path}`;

      const isJson = contentType.includes("application/json");
      const isMultipart = contentType.includes("multipart/");

      if (isJson) {
        // Rewrite RequestInfo in JSON body
        const rewrittenBody = this.proxy.rewriteRequestInfo(body, user, token);
        await this.forwardAndRespond(
          method,
          upstreamUrl,
          req,
          res,
          rewrittenBody,
        );
      } else if (isMultipart) {
        // Append auth query param for multipart
        const authedUrl = this.proxy.appendAuthParam(upstreamUrl, token);
        await this.forwardAndRespond(method, authedUrl, req, res, body);
      } else {
        // Other content types: forward with auth header
        const headers = this.buildHeaders(req);
        headers["authorization"] = `Bearer ${token}`;
        const result = await this.proxy.forward(method, upstreamUrl, headers, body);
        res.status(result.status).headers(result.headers).send(result.body);
      }
    } catch (err) {
      this.logger.error(`Proxy error: ${(err as Error).message}`);
      res.status(502).send({ error: "Bad Gateway", message: (err as Error).message });
    }
  }

  private async forwardAndRespond(
    method: string,
    upstreamUrl: string,
    req: FastifyRequest,
    res: FastifyReply,
    body: any,
  ): Promise<void> {
    const headers = this.buildHeaders(req);
    const result = await this.proxy.forward(method, upstreamUrl, headers, body);
    res.status(result.status).headers(result.headers).send(result.body);
  }

  private buildHeaders(req: FastifyRequest): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(", ");
      }
    }
    // Remove host header to avoid upstream confusion
    delete headers["host"];
    return headers;
  }
}
