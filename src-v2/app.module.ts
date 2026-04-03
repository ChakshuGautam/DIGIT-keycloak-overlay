import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { AppConfigModule } from "./config/config.module";
import { AuthModule } from "./auth/auth.module";
import { CacheModule } from "./cache/cache.module";
import { CircuitBreakerModule } from "./circuit-breaker/circuit-breaker.module";
import { MetricsModule } from "./metrics/metrics.module";
import { HealthModule } from "./health/health.module";
import { UserModule } from "./user/user.module";
import { KeycloakModule } from "./keycloak/keycloak.module";
import { LoginModule } from "./login/login.module";
import { ProxyModule } from "./proxy/proxy.module";

@Module({
  imports: [
    AppConfigModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    CacheModule,
    CircuitBreakerModule,
    AuthModule,
    MetricsModule,
    HealthModule,
    UserModule,
    KeycloakModule,
    LoginModule,
    ProxyModule, // LAST — wildcard catch-all
  ],
})
export class AppModule {}
