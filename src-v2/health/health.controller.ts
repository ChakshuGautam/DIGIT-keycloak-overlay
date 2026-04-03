import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { CircuitBreakerService } from "../circuit-breaker/circuit-breaker.service";

@Controller()
export class HealthController {
  private readonly cache: CacheService;
  private readonly circuitBreaker: CircuitBreakerService;

  constructor(cache: CacheService, circuitBreaker: CircuitBreakerService) {
    this.cache = cache;
    this.circuitBreaker = circuitBreaker;
  }

  @Get("/healthz")
  async liveness() {
    return { status: "ok" };
  }

  @Get("/readyz")
  async readiness() {
    const redisOk = await this.cache.ping();

    if (!redisOk) {
      throw new HttpException(
        { status: "degraded", redis: "disconnected" },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return {
      status: "ok",
      redis: "connected",
      circuits: this.circuitBreaker.getAllStates(),
    };
  }

  @Get("/debug/status")
  async debugStatus() {
    const mem = process.memoryUsage();
    return {
      redis: this.cache.isRedisHealthy(),
      circuits: this.circuitBreaker.getAllStates(),
      uptime: process.uptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
    };
  }
}
