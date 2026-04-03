import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { AuthModule } from "./auth/auth.module";
import { CacheModule } from "./cache/cache.module";
import { CircuitBreakerModule } from "./circuit-breaker/circuit-breaker.module";
import { MetricsModule } from "./metrics/metrics.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [AppConfigModule, AuthModule, CacheModule, CircuitBreakerModule, MetricsModule, HealthModule],
})
export class AppModule {}
