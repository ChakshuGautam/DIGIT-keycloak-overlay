import { Injectable } from "@nestjs/common";
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";

@Injectable()
export class MetricsService {
  private readonly registry: Registry;

  readonly httpRequestsTotal: Counter<"method" | "path" | "status">;
  readonly httpRequestDuration: Histogram<"method" | "path">;
  readonly jwtValidationTotal: Counter<"result">;
  readonly cacheOpsTotal: Counter<"op" | "result">;
  readonly userProvisionTotal: Counter<"result">;
  readonly circuitState: Gauge<"target">;
  readonly tokenRefreshTotal: Counter<"token_type" | "result">;
  readonly roleSyncTotal: Counter<"direction" | "result">;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestsTotal = new Counter({
      name: "tes_http_requests_total",
      help: "Total HTTP requests",
      labelNames: ["method", "path", "status"],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: "tes_http_request_duration_seconds",
      help: "HTTP request duration in seconds",
      labelNames: ["method", "path"],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });

    this.jwtValidationTotal = new Counter({
      name: "tes_jwt_validation_total",
      help: "Total JWT validations",
      labelNames: ["result"],
      registers: [this.registry],
    });

    this.cacheOpsTotal = new Counter({
      name: "tes_cache_ops_total",
      help: "Total cache operations",
      labelNames: ["op", "result"],
      registers: [this.registry],
    });

    this.userProvisionTotal = new Counter({
      name: "tes_user_provision_total",
      help: "Total user provisions",
      labelNames: ["result"],
      registers: [this.registry],
    });

    this.circuitState = new Gauge({
      name: "tes_circuit_breaker_state",
      help: "Circuit breaker state",
      labelNames: ["target"],
      registers: [this.registry],
    });

    this.tokenRefreshTotal = new Counter({
      name: "tes_token_refresh_total",
      help: "Total token refreshes",
      labelNames: ["token_type", "result"],
      registers: [this.registry],
    });

    this.roleSyncTotal = new Counter({
      name: "tes_role_sync_total",
      help: "Total role syncs",
      labelNames: ["direction", "result"],
      registers: [this.registry],
    });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
