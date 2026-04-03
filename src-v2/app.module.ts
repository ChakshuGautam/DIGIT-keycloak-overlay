import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { AuthModule } from "./auth/auth.module";
import { CircuitBreakerModule } from "./circuit-breaker/circuit-breaker.module";
import { MetricsModule } from "./metrics/metrics.module";

@Module({
  imports: [AppConfigModule, AuthModule, CircuitBreakerModule, MetricsModule],
})
export class AppModule {}
